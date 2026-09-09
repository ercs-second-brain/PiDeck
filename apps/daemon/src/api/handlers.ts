/**
 * Contract-typed REST handlers.
 *
 * `registerContractRoutes` walks the shared `endpoints` map: for every entry
 * it registers a router route whose params/request/response are validated
 * with the *shared zod schemas* — so a handler that returns something the
 * contract forbids (or a request the contract rejects) fails loudly (500 /
 * 400 / test failure), keeping the daemon honest against
 * `packages/shared/src/rest.ts`.
 *
 * The non-contract routes live in their own modules:
 * - `cli-handlers.ts` — the CLI action routes finalized in issue #9
 *   (documented in agent/README.md): `GET /api/status`,
 *   `POST /api/projects/:projectId/spawn`, `POST /api/sessions/:sessionId/send`,
 *   `POST /api/sessions/report-pr` (issue #49), plus the pi-auth probe;
 * - `gh-auth.ts` — the gh auth/repo-creation probe (`GET /api/gh-auth`).
 */

import type { z } from "zod";
import {
  ACTIVE_WORKER_STATUSES,
  endpoints,
  registerProjectRequestSchema,
  updateProjectRequestSchema,
  updateSettingsRequestSchema,
  workerSchema,
  type EndpointName,
  type Project,
} from "@pideck/shared";

import { HttpError, Router } from "./router.js";
import { NotFoundError } from "./projects.js";
import { listAccessibleRepos } from "../github/repos.js";
import { nodeStatus } from "./node-version.js";
import { handleAgentKindSpawn } from "./agent-kind-spawn.js";
import type { DaemonServices } from "./context.js";

// ---------------------------------------------------------------------------
// Shared-schema-wrapped handler plumbing
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- params/body are validated against the shared zod schemas in handleEndpoint before reaching a handler; the registry is endpoint-typed via EndpointRegistry
type AnyHandler = (args: { params: any; body: any; query?: string }) => Promise<unknown> | unknown;

type EndpointRegistry = {
  [N in EndpointName]: AnyHandler;
};

/**
 * Registers every contract endpoint with schema validation around the
 * handler. Response validation happens before serialization: a mismatch
 * between handler output and the shared response schema becomes a 500 with
 * the drift in the message (and a test failure), never a silently wrong
 * payload. A missing handler is itself a contract violation: the route is
 * registered as a loud 500 so the gap is visible at runtime and in the
 * contract coverage test.
 */
export function registerContractRoutes(router: Router, handlers: Partial<EndpointRegistry>): void {
  for (const [name, endpoint] of Object.entries(endpoints) as Array<[EndpointName, (typeof endpoints)[EndpointName]]>) {
    const handler = handlers[name as EndpointName];
    if (handler === undefined) {
      // Missing handler = contract violation; register a failing route so
      // the gap is visible at runtime and in the contract coverage test.
      router.add(endpoint.method, endpoint.path, () => {
        throw new HttpError(500, `endpoint "${name}" is declared in the shared contract but not implemented`);
      });
      continue;
    }
    router.add(endpoint.method, endpoint.path, (ctx) =>
      handleEndpoint(name, endpoint.params, endpoint.request, endpoint.response, handler, ctx),
    );
  }
}

async function handleEndpoint(
  name: EndpointName,
  paramsSchema: z.ZodType,
  requestSchema: z.ZodType | null,
  responseSchema: z.ZodType,
  handler: AnyHandler,
  ctx: { params: Record<string, string>; body: unknown; query?: string },
): Promise<{ status?: number; body?: unknown }> {
  const params = parsePathParams(paramsSchema, ctx.params, name);
  // Request validation failures propagate as ZodError → 400 (router).
  const body = requestSchema === null ? undefined : requestSchema.parse(ctx.body);
  const result = await handler({ params, body, query: ctx.query });
  if (result === undefined) return { status: 204 };
  try {
    return { body: responseSchema.parse(result) };
  } catch (err) {
    if (err instanceof Error && err.name === "ZodError") {
      throw new HttpError(500, `handler for "${name}" returned a body violating the shared contract: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Path params arrive as strings; contract schemas may expect numbers (e.g.
 * `prNumber`). Try them verbatim first (string params), then with numeric
 * coercion for numeric-looking segments.
 */
function parsePathParams(schema: z.ZodType, raw: Record<string, string>, name: EndpointName): unknown {
  const direct = schema.safeParse(raw);
  if (direct.success) return direct.data;
  const coerced: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw)) {
    coerced[key] = /^\d+$/.test(value) ? Number(value) : value;
  }
  const result = schema.safeParse(coerced);
  if (!result.success) throw new HttpError(400, `invalid path params for ${name}: ${direct.error.message}`);
  return result.data;
}

// ---------------------------------------------------------------------------
// 404 helper (the one style: NotFoundError from projects.ts)
// ---------------------------------------------------------------------------

/** The single 404 style over the projects.ts error classes. `null` counts as missing too. */
export function requireOr404<T>(value: T | null | undefined, message: string): T {
  if (value === undefined || value === null) throw new NotFoundError(message);
  return value;
}

/**
 * Payload builder for the archived-worker-log endpoint (issue #104): the
 * scrollback captured at terminate time plus the worker's final metadata.
 * 404 for unknown workers and for workers that are not archived — a live
 * worker has no archived log yet (its pane is still attachable instead).
 */
function archivedWorkerLogPayload(services: DaemonServices, workerId: string) {
  const worker = requireOr404(services.sessions.getWorker(workerId), `unknown worker: ${workerId}`);
  if (worker.status !== "archived") throw new HttpError(404, `worker ${worker.id} is not archived`);
  const captured = services.sessions.archivedScrollback(worker.id);
  return {
    workerId: worker.id,
    projectId: worker.projectId,
    issueNumber: worker.issueNumber,
    prNumber: worker.prNumber,
    prompt: worker.prompt ?? null,
    finalStatus: worker.status,
    finalStatusMessage: worker.statusMessage,
    startedAt: worker.startedAt,
    updatedAt: worker.updatedAt,
    capturedAt: captured?.capturedAt ?? null,
    scrollback: captured?.scrollback ?? "",
  };
}

/**
 * Worker files-changed payload (issue #126): resolves the worker (404) and
 * its project (404), then lets the diffs service pick the worker's PR files
 * or its branch-vs-default-branch listing (mid-flight / archived workers).
 */
function workerFilesChangedPayload(services: DaemonServices, workerId: string) {
  const worker = requireOr404(services.sessions.getWorker(workerId), `unknown worker: ${workerId}`);
  const project = requireOr404(services.projects.get(worker.projectId), `unknown project: ${worker.projectId}`);
  const session = services.sessions.getSession(worker.sessionId);
  return services.diffs.getWorkerFilesChanged(project.id, project.repoUrl, {
    worker,
    ...(session?.cwd !== undefined ? { sessionCwd: session.cwd } : {}),
    baseBranch: project.defaultBranch,
  });
}

/**
 * Terminate handler (issue #64): kills the tmux session, marks the worker
 * `archived`, and announces the new status on the hub so open sidebars
 * update live. Shared with the session-id terminate route
 * (session-terminate.ts, issue #317) so a worker reached through either
 * path gets identical archived semantics.
 */
export async function terminateWorkerPayload(services: DaemonServices, workerId: string) {
  const worker = await services.sessions.archiveWorker(workerId);
  const parsed = workerSchema.parse(requireOr404(worker, `unknown worker: ${workerId}`));
  services.hub.broadcast({
    type: "worker.status.changed",
    at: services.now().toISOString(),
    projectId: parsed.projectId,
    workerId: parsed.id,
    status: parsed.status,
  });
  return parsed;
}

/**
 * Relaunch handler (issue #117): 404 for unknown sessions, 409 for archived
 * ones (their history is the archived log view), then re-run the session's
 * launch path via `SessionManager.relaunchSession`. A worker bumped from
 * `stopped` back to `running` is announced on the hub so open sidebars and
 * kanban boards update live.
 */
async function relaunchSessionPayload(services: DaemonServices, sessionId: string) {
  const existing = requireOr404(services.sessions.getSession(sessionId), `unknown session: ${sessionId}`);
  const worker = existing.workerId !== null ? services.sessions.getWorker(existing.workerId) : undefined;
  if (worker?.status === "archived") {
    throw new HttpError(409, `session ${existing.id} is archived — its log is read-only history`);
  }
  // Registry workers are mutated in place, so capture the status value.
  const statusBefore = worker?.status;
  const session = await services.sessions.relaunchSession(sessionId);
  // Issue #290: the launch paths recreate orchestrator and agent-kind
  // panes as bare shells — putting pi back with the persona is the
  // bootstrap's job (identical to a fresh boot, global agent and kind
  // personas included, issue #310). Errors propagate: a relaunch that
  // leaves a bare shell is the bug this fixes, not a success.
  if (session.role === "orchestrator" || session.agentKind !== undefined) {
    await services.orchestratorBootstrap.ensureForSession(session);
  }
  const after = existing.workerId !== null ? services.sessions.getWorker(existing.workerId) : undefined;
  if (after && after.status !== statusBefore) {
    services.hub.broadcast({
      type: "worker.status.changed",
      at: services.now().toISOString(),
      projectId: after.projectId,
      workerId: after.id,
      status: after.status,
    });
  }
  return session;
}

/** Workers in an active status — the click-to-update gate (issue #76), via
 * the shared `ACTIVE_WORKER_STATUSES` (issue #70). Orchestrator sessions are
 * not workers (they persist across updates and never block). */
function countActiveWorkers(services: DaemonServices): number {
  return services.sessions.listWorkers().filter((worker) => ACTIVE_WORKER_STATUSES.has(worker.status)).length;
}

// ---------------------------------------------------------------------------
// The webapp contract handlers
// ---------------------------------------------------------------------------

/**
 * Registers a project and ends the creation path with the orchestrator
 * persona running (issue #166): the daemon startup sweep only covers
 * projects known at boot, so a mid-run registration (the webapp wizard's
 * `POST /api/projects`) bootstraps its orchestrator here. Best-effort: the
 * project is registered; a bootstrap failure (e.g. tmux trouble) is logged,
 * never fails the registration.
 */
function projectSessionsPayload(services: DaemonServices, projectId: string) {
  requireOr404(services.projects.get(projectId), `unknown project: ${projectId}`);
  return services.sessions.listSessions(projectId);
}

function projectWorkersPayload(services: DaemonServices, projectId: string) {
  requireOr404(services.projects.get(projectId), `unknown project: ${projectId}`);
  return services.sessions.listWorkers({ projectId });
}

async function registerAndBootstrap(services: DaemonServices, body: unknown): Promise<Project> {
  const project = await services.projects.register(registerProjectRequestSchema.parse(body));
  try {
    await services.orchestratorBootstrap.ensureForProject(project);
  } catch (err) {
    console.error(`[daemon] orchestrator bootstrap failed for project "${project.id}":`, err);
  }
  return project;
}

/**
 * Per-persona agent-asset handlers (issue #315): the webapp's asset editor.
 * Extracted so `contractHandlers` stays within its line budget.
 */
function agentAssetHandlers(services: DaemonServices): Pick<EndpointRegistry, "getAgentAssets" | "savePromptOverride" | "deletePromptOverride" | "saveAgentSkill" | "deleteAgentSkill"> {
  return {
    getAgentAssets: () => services.agentAssets.list(),
    savePromptOverride: ({ params, body }) => services.agentAssets.savePromptOverride(params.persona, body.content),
    deletePromptOverride: ({ params }) => {
      if (!services.agentAssets.deletePromptOverride(params.persona)) {
        throw new HttpError(404, `no prompt override stored for persona "${params.persona}"`);
      }
      return undefined;
    },
    saveAgentSkill: ({ params, body }) => services.agentAssets.saveSkill(params.skillId, body),
    deleteAgentSkill: ({ params }) => {
      if (!services.agentAssets.deleteSkill(params.skillId)) {
        throw new HttpError(404, `unknown skill: "${params.skillId}"`);
      }
      return undefined;
    },
  };
}

/** Builds the handler registry for every entry of the shared endpoint map. */
export function contractHandlers(services: DaemonServices): EndpointRegistry {
  return {
    listProjects: () => services.projects.list(),

    registerProject: ({ body }) => registerAndBootstrap(services, body),

    getProject: ({ params }) =>
      requireOr404(services.projects.get(params.projectId), `unknown project: ${params.projectId}`),

    updateProject: ({ params, body }) => services.projects.update(params.projectId, updateProjectRequestSchema.parse(body)),

    /** Issue #172: full local teardown — ordering + guards live in ProjectService.delete. */
    deleteProject: async ({ params }) => {
      await services.projects.delete(params.projectId);
      return undefined;
    },

    getProjectKanban: async ({ params }) => {
      const project = requireOr404(services.projects.get(params.projectId), `unknown project: ${params.projectId}`);
      return services.kanban.getBoard(project);
    },

    listProjectSessions: ({ params }) => projectSessionsPayload(services, params.projectId),

    // Every session daemon-wide (including the global agent's, projectId
    // `global`): backs the sidebar's global-agent row and `pideck sessions`.
    listAllSessions: () => services.sessions.listSessions(),

    // Start (or attach to) the workspace-level global agent (hierarchy top).
    ensureGlobalAgent: () => services.orchestratorBootstrap.ensureGlobalAgent(),

    listProjectWorkers: ({ params }) => projectWorkersPayload(services, params.projectId),

    /**
     * Start (or reuse) the project's orchestrator session (issue #53): a
     * thin wrapper over `SessionManager.ensureOrchestrator`, so the webapp
     * terminal sidebar can bring up an orchestrator and attach to its pane.
     * Idempotent: returns the live session when one already exists.
     */
    ensureProjectOrchestrator: async ({ params }) => {
      requireOr404(services.projects.get(params.projectId), `unknown project: ${params.projectId}`);
      return services.sessions.ensureOrchestrator(params.projectId);
    },

    /**
     * Terminate a worker (issue #64): kills its tmux session, marks the
     * worker `archived`, and keeps the registry records for history. The
     * new status is announced on the hub so open sidebars update live.
     */
    terminateWorker: ({ params }) => terminateWorkerPayload(services, params.workerId),

    /**
     * Archived worker session log (issue #104): the scrollback captured at
     * terminate time plus the worker's final metadata (see the payload
     * builder below for the 404 semantics).
     */
    getArchivedWorkerLog: ({ params }) => archivedWorkerLogPayload(services, params.workerId),

    // Worker files-changed (issue #126): PR files, or branch vs default branch pre-PR.
    getWorkerFilesChanged: ({ params }) => workerFilesChangedPayload(services, params.workerId),

    spawnProjectAgent: ({ params, body }) => handleAgentKindSpawn(services, params.projectId, body), // docs/agent-kinds.md

    /**
     * Relaunch a dead session's tmux pane (issue #117): kills any lingering
     * tmux session of the name and re-runs the session's launch path (see
     * `SessionManager.relaunchSession`). 404 for unknown sessions, 409 for
     * archived ones (their history is the archived log view). A worker
     * bumped from `stopped` back to `running` is announced on the hub so
     * open sidebars/kanban boards update live.
     */
    relaunchSession: ({ params }) => relaunchSessionPayload(services, params.sessionId),

    listProjectPullRequests: async ({ params }) => {
      const project = requireOr404(services.projects.get(params.projectId), `unknown project: ${params.projectId}`);
      return services.diffs.listPullRequests(project.id, project.repoUrl);
    },

    getPullRequestDiff: async ({ params }) => {
      const project = requireOr404(services.projects.get(params.projectId), `unknown project: ${params.projectId}`);
      return services.diffs.getDiff(project.id, project.repoUrl, params.prNumber);
    },

    getSettings: () => services.settings.get(),

    /** Accessible repos for the onboarding selector (issue #217). */
    listAccessibleRepos: () => listAccessibleRepos(services.gh("https://github.com/list")),

    updateSettings: ({ body }) => services.settings.update(updateSettingsRequestSchema.parse(body)),

    ...agentAssetHandlers(services),

    // Self-update (issues #55, #76, #82): the check result plus the live
    // active-worker count — the webapp disables its update button on the
    // same data the apply endpoint gates with. The gh check is cached ~5 min
    // server-side; `?refresh=1` (webapp page load / window focus) bypasses
    // that cache. Fresh worker count every poll.
    getUpdateStatus: async ({ query = "" }) => {
      const refresh = new URLSearchParams(query).get("refresh") === "1";
      const status = await services.update.check({ force: refresh });
      return { ...status, activeWorkers: countActiveWorkers(services), ...nodeStatus() }; // issue #202 webapp warning
    },

    /**
     * Apply update (issue #76): gates server-side on zero active workers
     * (never trust the client — a worker spawned since the last poll still
     * aborts cleanly with 409), then spawns the `pideck update` shim
     * detached and returns immediately; the daemon restarts mid-apply, so
     * the webapp polls `GET /api/update` until the new SHA shows up.
     */
    applyUpdate: async () => {
      const active = countActiveWorkers(services);
      if (active > 0) {
        throw new HttpError(
          409,
          `update blocked: ${active} worker${active === 1 ? "" : "s"} still active — updates apply only when every agent is idle`,
        );
      }
      await services.update.apply();
      return { ok: true };
    },
  };
}
