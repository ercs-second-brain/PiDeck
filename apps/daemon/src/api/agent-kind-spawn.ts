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
 *   session); otherwise audit kinds fall back to the project orchestrator
 *   they report to, while caller-routed kinds (investigator) reject — a
 *   guessed parent would misroute the report;
 * - issue #56 parity: the investigator's question is typed into the pane
 *   only when pi auth is ready, else queued on the prompt gate;
 * - concurrency (§5): worker-like kinds (audits) count toward the project's
 *   `workerConcurrency` cap alongside workers; investigator spawns are
 *   cheap and exempt.
 */

import { ACTIVE_WORKER_STATUSES, AGENT_KIND_INFO, AGENT_KIND_REPORT_TARGET, type AgentKind, type Session } from "@pideck/shared";

import { HttpError } from "./router.js";
import { requireOr404 } from "./handlers.js";
import type { DaemonServices } from "./context.js";
import { discoverCallerSession, tmuxPanePids } from "../sessions/caller-discovery.js";
import { agentKindSpec } from "../sessions/agent-kinds.js";

/** The spawn input both routes accept (validated by their schemas). */
export interface SpawnAgentKindInput {
  kind: AgentKind;
  name: string;
  question?: string;
  parentSessionId?: string;
}

/**
 * Resolves the parent session id (docs/agent-kinds.md §3): explicit → the
 * calling pane (discovery) → the project orchestrator for
 * orchestrator-routed kinds. Caller-routed kinds without a resolvable
 * parent reject: the investigator's report MUST reach its caller, and a
 * guessed parent would silently misroute it.
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
  if (AGENT_KIND_REPORT_TARGET[input.kind] === "project-orchestrator") {
    // Via the bootstrap: the report target is ensured WITH its persona
    // (idempotent), not as a bare shell.
    return (await services.orchestratorBootstrap.ensureForProject(
      requireOr404(services.projects.get(projectId), `unknown project: ${projectId}`),
    )).id;
  }
  throw new HttpError(
    409,
    `cannot determine the calling session for the ${input.kind} spawn — agent kinds report to their caller; spawn from an agent pane (global agent, orchestrator, worker, or reviewer) or pass parentSessionId`,
  );
}

/**
 * One bounded question-delivery attempt for the freshly spawned pane
 * (issue #318): waits for pi's input box, then sends ONCE with the
 * explicit Enter. `false` = the pane never became ready in time (caller
 * queues on the prompt gate instead — never a swallowed question).
 */
async function tryDeliverQuestion(services: DaemonServices, session: Session, question: string): Promise<boolean> {
  if (!(await services.paneReady(session.tmuxSession))) return false;
  await services.sessions.sendKeys(session.id, question, { enter: true });
  return true;
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
  // §5): they occupy a real workspace like workers; investigator spawns are
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
  // correct independently of it). Issue #318: even with auth ready, the
  // pane was just created — wait for pi to accept input before typing, or
  // the question lands in its startup window and the Enter is swallowed
  // (typed-but-never-sent). A pane that never shows its input box in time
  // queues on the gate (deduped per session; the gate's retries wait for
  // readiness the same way).
  const question = AGENT_KIND_INFO[input.kind].takesInput ? input.question : undefined;
  if (question !== undefined) {
    const piAuth = await services.piAuth.payload();
    if (piAuth.ready) {
      const delivered = await tryDeliverQuestion(services, session, question);
      if (!delivered) services.promptGate.queueSession(session.id, question);
    } else {
      services.promptGate.queueSession(session.id, question);
    }
  }
  return session;
}
