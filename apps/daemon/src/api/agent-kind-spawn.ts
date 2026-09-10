/**
 * Agent-kind spawn route handler (docs/agent-kinds.md, issues
 * #297/#300/#302/#330) — the api-layer half of the mechanism; the tmux/registry
 * mechanics live in `sessions/agent-kind-spawn.ts`, the persona launch in
 * `orchestrator/bootstrap.ts` (the #290 pattern — bare-shell pane + one
 * idempotent typing step shared by spawn, relaunch, and the startup sweep).
 *
 * Owns the request-shaped decisions:
 * - kind resolution (registry v2, issue #330): the spec comes from the
 *   daemon's {@link AgentKindRegistry} (user kinds first, then shipped) —
 *   unknown kinds 404, nothing is hardcoded;
 * - spawnableBy enforcement (spec v2): a resolvable agent caller (explicit
 *   parent or discovered pane) must be a role the kind lists; user-driven
 *   spawns (web ⋯ menu, CLI) have no agent caller and are unrestricted;
 * - parent-of-any-role resolution (§3): an explicit `parentSessionId` wins;
 *   otherwise the calling pane is discovered from the live spawn process
 *   (the caller may be a global-agent, orchestrator, worker, or reviewer
 *   session); otherwise the project's orchestrator is the fallback parent
 *   for every kind (issue #328) — project-context spawns (the web ⋯ menu,
 *   a CLI run from a terminal) have no calling agent pane, and the
 *   orchestrator is their caller-of-record, ensured first via the
 *   bootstrap — never a bare 409;
 * - issue #56 parity: a waitForInput kind's input is typed into the pane
 *   only when pi auth is ready, else queued on the prompt gate;
 * - concurrency (§5): worker-like kinds count toward the project's
 *   `workerConcurrency` cap alongside workers; cheap spawns are exempt.
 */

import { GLOBAL_AGENT_PROJECT_ID, type AgentKindSpec, type Project, type Session, type Worker } from "@pideck/shared";

import { countProjectOccupants } from "../sessions/occupancy.js";
import { HttpError } from "./router.js";
import { requireOr404 } from "./handlers.js";
import type { DaemonServices } from "./context.js";
import { callerWaitsNotice, planAgentKindSpawn } from "../agent/prompt-gate.js";
import { discoverCallerSession, tmuxPanePids } from "../sessions/caller-discovery.js";
import { renderAgentKindTask } from "../sessions/agent-kinds.js";
import { orchestratorPromptValues } from "../orchestrator/prompt.js";

/** The spawn input both routes accept (validated by their schemas). */
export interface SpawnAgentKindInput {
  kind: string;
  name: string;
  question?: string;
  parentSessionId?: string;
}

/** The caller role a session contributes to spawnableBy checks (spec v2). */
function sessionSpawnableRole(session: Session, getWorker: (id: string) => Worker | undefined): string {
  if (session.role === "orchestrator") {
    return session.projectId === GLOBAL_AGENT_PROJECT_ID ? "global" : "orchestrator";
  }
  if (session.workerId !== null) {
    const worker = getWorker(session.workerId);
    if (worker?.kind === "reviewer") return "reviewer";
  }
  return "worker";
}

/**
 * Resolves the parent session id (docs/agent-kinds.md §3): explicit → the
 * calling pane (discovery) → the project's orchestrator (issue #328). The
 * orchestrator fallback is unconditional: a spawn from a project context
 * (the web ⋯ menu, a plain terminal) has no calling agent pane to
 * discover, and the project orchestrator is the caller-of-record there —
 * reports and sidebar nesting land on a live session instead of a 409.
 */
async function resolveParent(
  services: DaemonServices,
  projectId: string,
  input: SpawnAgentKindInput,
): Promise<{ parentSessionId: string; caller?: Session }> {
  // The calling session, when explicit or discovered (spawnableBy checks).
  if (input.parentSessionId !== undefined) {
    const session = requireOr404(
      services.sessions.getSession(input.parentSessionId),
      `unknown parent session: ${input.parentSessionId}`,
    );
    return { parentSessionId: session.id, caller: session };
  }
  const callerTmux = await discoverCallerSession({
    panePids: () => tmuxPanePids(services.tmux),
    processes: services.callerProcesses,
  });
  if (callerTmux !== undefined) {
    const session = services.registry.getSessionByTmuxName(callerTmux);
    if (session !== undefined) return { parentSessionId: session.id, caller: session };
  }
  // Via the bootstrap: the fallback parent is ensured WITH its persona
  // (idempotent), not as a bare shell.
  return {
    parentSessionId: (await services.orchestratorBootstrap.ensureForProject(
      requireOr404(services.projects.get(projectId), `unknown project: ${projectId}`),
    )).id,
  };
}

/**
 * The spawn-path prompt delivery (issues #56/#318), shared by a
 * waitForInput kind's input and the auto kinds' taskTemplate (issue #329):
 * never type into an agent that cannot run (pi-auth gate, else queue on
 * the prompt gate); even with auth ready the pane was just created — wait
 * for pi to accept input, type the text exactly ONCE with one Enter, and
 * confirm acceptance (bare-Enter nudges only; the text is never re-typed).
 * A pane that never readies in time queues on the gate (deduped per
 * session); a typed-but-unconfirmed draft stays visible in the composer
 * and must NOT be queued (double delivery).
 */
async function deliverSpawnPrompt(services: DaemonServices, sessionId: string, text: string): Promise<void> {
  const piAuth = await services.piAuth.payload();
  if (piAuth.ready) {
    const delivered = await services.sessions.deliverPromptWhenReady(sessionId, text);
    if (!delivered.typed) services.promptGate.queueSession(sessionId, text);
  } else {
    services.promptGate.queueSession(sessionId, text);
  }
}

/**
 * Spawns one agent-kind session (the handler behind both
 * `POST /api/projects/:projectId/spawn` with `kind` and the contract
 * endpoint `POST /api/projects/:projectId/spawn-agent`). Renamed in
 * issue #324 — it shadowed the sessions-layer `spawnAgentKindSession`, a
 * same-named but different-layer function. Returns the new
 * session record — agent-kind sessions are not workers. The persona launch
 * line is typed into the bare-shell pane (bootstrap, issue #310) before
 * the response returns.
 */
export async function handleAgentKindSpawn(services: DaemonServices, projectId: string, input: SpawnAgentKindInput): Promise<Session> {
  const project = requireOr404(services.projects.get(projectId), `unknown project: ${projectId}`);
  // Registry v2 (issue #330): the kind spec resolves from the live registry.
  const spec = requireOr404(services.agentKinds.get(input.kind), `unknown agent kind: ${input.kind}`);

  // The trigger decides whether the kind carries caller input at all —
  // reject before anything is spawned (the CLI enforces the same rule;
  // the handler stays correct independently of it).
  if (input.question !== undefined && spec.trigger !== "waitForInput") {
    throw new HttpError(409, `--question is not an input of kind "${input.kind}" (trigger: ${spec.trigger}; it takes no input)`);
  }

  // Worker-concurrency cap applies to worker-like kinds (docs/agent-kinds.md
  // §5): they occupy a real workspace like workers; cheap spawns are
  // exempt. Occupancy is the ONE shared predicate (issue #393): active
  // workers + live workerLike kind sessions, identical on every spawn path.
  if (spec.workerLike) {
    const cap = project.settings.workerConcurrency;
    if (cap != null) {
      const occupants = countProjectOccupants(services.sessions, services.agentKinds, projectId);
      if (occupants >= cap) {
        throw new HttpError(
          409,
          `worker concurrency cap reached for project "${projectId}" (${occupants}/${cap} active)`,
        );
      }
    }
  }

  const { parentSessionId, caller } = await resolveParent(services, projectId, input);

  // spawnableBy (spec v2, issue #330): an identified agent caller must be a
  // role the kind lists. A session with no caller is a user-driven spawn
  // (web menu / CLI) — unrestricted.
  if (caller !== undefined) {
    const role = sessionSpawnableRole(caller, (id) => services.registry.getWorker(id));
    if (!spec.spawnableBy.includes(role as never)) {
      throw new HttpError(
        403,
        `kind "${input.kind}" cannot be spawned by ${role} sessions (spawnableBy: ${spec.spawnableBy.join(", ")})`,
      );
    }
  }

  const session = await services.sessions.spawnAgentKind(projectId, {
    kind: input.kind,
    parentSessionId,
    name: input.name,
  });
  // The #290 launch pattern: the bootstrap renders the kind persona (parent
  // lineage + report target) and types the pi launch line — idempotently.
  await services.orchestratorBootstrap.ensureForSession(session);

  // Prompt-gate v2 (issue #333): the kind spec plans the post-boot behavior
  // — an auto kind's taskTemplate, a waitForInput kind's caller input, or
  // nothing (the pane sits ready) — and a callerWaits kind exposes
  // completion to its calling pane. All of it rides the #56/#318 gated
  // path ({@link deliverSpawnPlan}): never typed into an agent that cannot
  // run, queued on the gate otherwise, exactly-once submit.
  const plan = planAgentKindSpawn(spec, input.question);
  await deliverPlan(services, spec, plan, project, session, caller, input.name);
  return session;
}

/**
 * Executes a spawn's spec-planned deliveries (issue #333): the pane
 * delivery (taskTemplate / caller input / none) plus the caller-waits
 * notice to the calling pane. Every delivery rides the gated path —
 * never typed into an agent that cannot run, queued on the gate otherwise,
 * and exactly-once (the #318 readiness wait + submit confirmation).
 */
async function deliverPlan(
  services: DaemonServices,
  spec: AgentKindSpec,
  plan: ReturnType<typeof planAgentKindSpawn>,
  project: Project,
  session: Session,
  caller: Session | undefined,
  name: string,
): Promise<void> {
  if (plan.delivery.kind === "caller-input") {
    await deliverSpawnPrompt(services, session.id, plan.delivery.text);
  } else if (plan.delivery.kind === "task") {
    // The taskTemplate renders with the same context as the persona
    // (project placeholders + the report-target session id, mirroring the
    // bootstrap's rendering); the #318 readiness wait + submit confirmation
    // make the delivery exactly-once (no double-submit).
    const task = renderAgentKindTask(spec, {
      ...orchestratorPromptValues(project, session.cwd ?? ""),
      ...(spec.reportTarget === "orchestrator"
        ? { ORCHESTRATOR_SESSION_ID: session.parentSessionId ?? "" }
        : { PARENT_SESSION_ID: session.parentSessionId ?? "" }),
    });
    if (task !== undefined) await deliverSpawnPrompt(services, session.id, task);
  }

  // callerWaits (spec v2, issue #333): the calling pane is told a report is
  // coming to THIS session, so its flow waits instead of guessing. Only
  // caller-routed kinds can do this (an orchestrator-routed kind reports
  // elsewhere — the planner already returns false for those).
  if (plan.notifyCaller && caller !== undefined) {
    await deliverSpawnPrompt(services, caller.id, callerWaitsNotice(spec, name));
  }
}
