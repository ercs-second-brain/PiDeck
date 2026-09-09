/**
 * Agent-kind spawn route handler (docs/agent-kinds.md, issues
 * #297/#300/#302) — the api-layer half of the mechanism; the tmux/registry
 * mechanics live in `sessions/agent-kind-spawn.ts`, the persona launch in
 * `orchestrator/bootstrap.ts` (the #290 pattern — bare-shell pane + one
 * idempotent typing step shared by spawn, relaunch, and the startup sweep).
 *
 * Owns the request-shaped decisions:
 * - parent-of-any-role resolution (§3): an explicit `parentSessionId` wins;
 *   otherwise the calling pane is discovered from the live spawn process
 *   (the caller may be a global-agent, orchestrator, worker, or reviewer
 *   session); otherwise the project's orchestrator is the fallback parent
 *   for every kind (issue #328) — project-context spawns (the web ⋯ menu,
 *   a CLI run from a terminal) have no calling agent pane, and the
 *   orchestrator is their caller-of-record, ensured first via the
 *   bootstrap — never a bare 409;
 * - issue #56 parity: the researcher's question is typed into the pane
 *   only when pi auth is ready, else queued on the prompt gate;
 * - concurrency (§5): worker-like kinds (audits) count toward the project's
 *   `workerConcurrency` cap alongside workers; researcher spawns are
 *   cheap and exempt.
 */

import { ACTIVE_WORKER_STATUSES, AGENT_KIND_INFO, AGENT_KIND_REPORT_TARGET, type AgentKind, type Session } from "@pideck/shared";

import { HttpError } from "./router.js";
import { requireOr404 } from "./handlers.js";
import type { DaemonServices } from "./context.js";
import { discoverCallerSession, tmuxPanePids } from "../sessions/caller-discovery.js";
import { agentKindSpec, renderAgentKindTask } from "../sessions/agent-kinds.js";
import { orchestratorPromptValues } from "../orchestrator/prompt.js";

/** The spawn input both routes accept (validated by their schemas). */
export interface SpawnAgentKindInput {
  kind: AgentKind;
  name: string;
  question?: string;
  parentSessionId?: string;
}

/**
 * Resolves the parent session id (docs/agent-kinds.md §3): explicit → the
 * calling pane (discovery) → the project's orchestrator (issue #328). The
 * orchestrator fallback is unconditional: a spawn from a project context
 * (the web ⋯ menu, a plain terminal) has no calling agent pane to
 * discover, and the project orchestrator is the caller-of-record there —
 * reports and sidebar nesting land on a live session instead of a 409.
 */
async function resolveParentSessionId(
  services: DaemonServices,
  projectId: string,
  input: SpawnAgentKindInput,
): Promise<string> {
  if (input.parentSessionId !== undefined) {
    const session = requireOr404(
      services.sessions.getSession(input.parentSessionId),
      `unknown parent session: ${input.parentSessionId}`,
    );
    return session.id;
  }
  const caller = await discoverCallerSession({
    panePids: () => tmuxPanePids(services.tmux),
    processes: services.callerProcesses,
  });
  if (caller !== undefined) {
    const session = services.registry.getSessionByTmuxName(caller);
    if (session !== undefined) return session.id;
  }
  // Via the bootstrap: the fallback parent is ensured WITH its persona
  // (idempotent), not as a bare shell.
  return (await services.orchestratorBootstrap.ensureForProject(
    requireOr404(services.projects.get(projectId), `unknown project: ${projectId}`),
  )).id;
}

/**
 * The spawn-path prompt delivery (issues #56/#318), shared by the
 * researcher's question and the autonomous kinds' auto-task (issue #329):
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
  const spec = agentKindSpec(input.kind);

  // Worker-concurrency cap applies to worker-like kinds (docs/agent-kinds.md
  // §5): they occupy a real workspace like workers; researcher spawns are
  // exempt. Counted alongside the project's active workers.
  if (spec.workerLike) {
    const cap = project.settings.workerConcurrency;
    if (cap != null) {
      const activeWorkers = services.sessions
        .listWorkers({ projectId })
        .filter((worker) => ACTIVE_WORKER_STATUSES.has(worker.status)).length;
      const liveAudits = services.sessions
        .listSessions(projectId)
        .filter((session) => session.agentKind !== undefined && agentKindSpec(session.agentKind).workerLike).length;
      if (activeWorkers + liveAudits >= cap) {
        throw new HttpError(
          409,
          `worker concurrency cap reached for project "${projectId}" (${activeWorkers + liveAudits}/${cap} active)`,
        );
      }
    }
  }

  const parentSessionId = await resolveParentSessionId(services, projectId, input);
  const session = await services.sessions.spawnAgentKind(projectId, {
    kind: input.kind,
    parentSessionId,
    name: input.name,
  });
  // The #290 launch pattern: the bootstrap renders the kind persona (parent
  // lineage + report target) and types the pi launch line — idempotently.
  await services.orchestratorBootstrap.ensureForSession(session);

  // Issue #56 parity: never type the question into an agent that cannot
  // run — gate it on pi auth readiness like worker prompts. The shared
  // spec's takesInput (issue #324) decides whether the kind carries a
  // question at all (the schema enforces the same rule; the handler stays
  // correct independently of it). The exact gating mechanics are
  // {@link deliverSpawnPrompt}.
  const question = AGENT_KIND_INFO[input.kind].takesInput ? input.question : undefined;
  if (question !== undefined) await deliverSpawnPrompt(services, session.id, question);

  // Issue #329: autonomous kinds carry an auto-task in their kind spec —
  // the work order that triggers the thing after the persona boot (the
  // persona loaded the who; without this the agent sits idle). Rendered
  // with the same context as the persona (project placeholders + the
  // report-target session id, mirroring the bootstrap's rendering) and
  // delivered through the identical gated path as the question — the #318
  // readiness wait + submit confirmation makes the delivery exactly-once
  // (no double-submit). Task-less kinds (researcher) type nothing here:
  // they wait for their caller's question.
  const task = renderAgentKindTask(spec, {
    ...orchestratorPromptValues(project, session.cwd ?? ""),
    ...(AGENT_KIND_REPORT_TARGET[input.kind] === "project-orchestrator"
      ? { ORCHESTRATOR_SESSION_ID: session.parentSessionId ?? "" }
      : { PARENT_SESSION_ID: session.parentSessionId ?? "" }),
  });
  if (task !== undefined) await deliverSpawnPrompt(services, session.id, task);
  return session;
}
