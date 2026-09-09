/**
 * Agent-kind spawn route handler (docs/agent-kinds.md, issues
 * #297/#300/#302) — the api-layer half of the mechanism; the tmux/registry
 * mechanics live in `sessions/agent-kind-spawn.ts`.
 *
 * Owns everything persona/report-target shaped:
 * - parent-of-any-role resolution (§3): an explicit `parentSessionId` wins;
 *   otherwise the calling pane is discovered from the live spawn process
 *   (the caller may be a global-agent, orchestrator, worker, or reviewer
 *   session); otherwise audit kinds fall back to the project orchestrator
 *   they report to, while caller-routed kinds (investigator) reject — a
 *   guessed parent would misroute the report;
 * - persona rendering: `agent/prompts/<kind>.md` with the project
 *   placeholders plus `{{PARENT_SESSION_ID}}` / `{{ORCHESTRATOR_SESSION_ID}}`
 *   (shared `AGENT_KIND_REPORT_TARGET`), written next to the project's
 *   state so relaunch/reconcile re-run the identical command;
 * - read-only enforcement: the pane launches with the write tools excluded
 *   (`sessions/agent-kinds.ts`);
 * - issue #56 parity: the investigator's question is typed into the pane
 *   only when pi auth is ready, else queued on the prompt gate;
 * - concurrency (§5): worker-like kinds (audits) count toward the project's
 *   `workerConcurrency` cap alongside workers; investigator spawns are
 *   cheap and exempt.
 */

import { readFileSync } from "node:fs";

import { ACTIVE_WORKER_STATUSES, AGENT_KIND_REPORT_TARGET, type Session } from "@pideck/shared";

import { HttpError } from "./router.js";
import { requireOr404 } from "./handlers.js";
import type { DaemonServices } from "./context.js";
import { atomicWrite } from "../json-store.js";
import { discoverCallerSession, tmuxPanePids } from "../sessions/caller-discovery.js";
import { agentKindLaunchCommand, agentKindPromptFilePath, agentKindSpec } from "../sessions/agent-kinds.js";
import { ProjectLayout } from "../sessions/layout.js";
import { findAgentPromptPath, orchestratorPromptValues, renderTemplate } from "../orchestrator/prompt.js";

/** The spawn input both routes accept (validated by their schemas). */
export interface SpawnAgentKindInput {
  kind: "investigator" | "devex-audit" | "kiss-audit";
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
    return (await services.sessions.ensureOrchestrator(projectId)).id;
  }
  throw new HttpError(
    409,
    `cannot determine the calling session for the ${input.kind} spawn — agent kinds report to their caller; spawn from an agent pane (global agent, orchestrator, worker, or reviewer) or pass parentSessionId`,
  );
}

/**
 * Spawns one agent-kind session (the handler behind both
 * `POST /api/projects/:projectId/spawn` with `kind` and the contract
 * endpoint `POST /api/projects/:projectId/spawn-agent`). Returns the new
 * session record — agent-kind sessions are not workers.
 */
export async function spawnAgentKindSession(services: DaemonServices, projectId: string, input: SpawnAgentKindInput): Promise<Session> {
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
  // Orchestrator-routed kinds report to the project orchestrator: ensure it
  // exists so the report route always has a live target — and render its id
  // into the persona. Caller-routed kinds never need it.
  const orchestrator =
    AGENT_KIND_REPORT_TARGET[input.kind] === "project-orchestrator"
      ? await services.sessions.ensureOrchestrator(projectId)
      : undefined;

  const layout = new ProjectLayout(services.stateDir);
  const template = readAgentKindTemplate(spec.personaFile);
  const session = await services.sessions.spawnAgentKind(projectId, {
    kind: input.kind,
    parentSessionId,
    name: input.name,
    buildCommand: ({ sessionId, cwd }) => {
      // Rendered at launch time: the persona embeds the parent/orchestrator
      // session ids and the resolved working directory (PROJECT_PATH).
      const content = renderTemplate(template, {
        ...orchestratorPromptValues(project, cwd),
        ...(orchestrator !== undefined ? { ORCHESTRATOR_SESSION_ID: orchestrator.id } : {}),
        PARENT_SESSION_ID: parentSessionId,
      });
      const promptFile = agentKindPromptFilePath(layout, projectId, sessionId);
      atomicWrite(promptFile, content);
      return agentKindLaunchCommand({ sessionId, promptFile, readOnly: spec.readOnly });
    },
  });

  // Issue #56 parity: never type the question into an agent that cannot
  // run — gate it on pi auth readiness like worker prompts.
  if (input.question !== undefined) {
    const piAuth = await services.piAuth.payload();
    if (piAuth.ready) {
      await services.sessions.sendKeys(session.id, input.question, { enter: true });
    } else {
      services.promptGate.queueSession(session.id, input.question);
    }
  }
  return session;
}

/** Reads the kind's persona template (auto-discovered like the orchestrator's). */
function readAgentKindTemplate(personaFile: string): string {
  try {
    return readFileSync(findAgentPromptPath(undefined, personaFile), "utf8");
  } catch (err) {
    throw new HttpError(
      500,
      `agent-kind persona template could not be read (${personaFile}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
