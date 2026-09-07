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
} from "@agentskiss/shared";

import { HttpError, Router } from "./router.js";
import { NotFoundError } from "./projects.js";
import type { DaemonServices } from "./context.js";

// ---------------------------------------------------------------------------
// Shared-schema-wrapped handler plumbing
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- params/body are validated against the shared zod schemas in handleEndpoint before reaching a handler; the registry is endpoint-typed via EndpointRegistry
type AnyHandler = (args: { params: any; body: any }) => Promise<unknown> | unknown;

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
  ctx: { params: Record<string, string>; body: unknown },
): Promise<{ status?: number; body?: unknown }> {
  const params = parsePathParams(paramsSchema, ctx.params, name);
  // Request validation failures propagate as ZodError → 400 (router).
  const body = requestSchema === null ? undefined : requestSchema.parse(ctx.body);
  const result = await handler({ params, body });
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

/** Workers in an active status — the click-to-update gate (issue #76), via
 * the shared `ACTIVE_WORKER_STATUSES` (issue #70). Orchestrator sessions are
 * not workers (they persist across updates and never block). */
export function countActiveWorkers(services: DaemonServices): number {
  return services.sessions.listWorkers().filter((worker) => ACTIVE_WORKER_STATUSES.has(worker.status)).length;
}

// ---------------------------------------------------------------------------
// The webapp contract handlers
// ---------------------------------------------------------------------------

/** Builds the handler registry for every entry of the shared endpoint map. */
export function contractHandlers(services: DaemonServices): EndpointRegistry {
  return {
    listProjects: () => services.projects.list(),

    registerProject: ({ body }) => services.projects.register(registerProjectRequestSchema.parse(body)),

    getProject: ({ params }) =>
      requireOr404(services.projects.get(params.projectId), `unknown project: ${params.projectId}`),

    updateProject: ({ params, body }) => services.projects.update(params.projectId, updateProjectRequestSchema.parse(body)),

    deleteProject: ({ params }) => {
      requireOr404(services.projects.get(params.projectId), `unknown project: ${params.projectId}`);
      services.projects.delete(params.projectId);
      return undefined;
    },

    getProjectKanban: async ({ params }) => {
      const project = requireOr404(services.projects.get(params.projectId), `unknown project: ${params.projectId}`);
      return services.kanban.getBoard(project);
    },

    listProjectSessions: ({ params }) => {
      requireOr404(services.projects.get(params.projectId), `unknown project: ${params.projectId}`);
      return services.sessions.listSessions(params.projectId);
    },

    listProjectWorkers: ({ params }) => {
      requireOr404(services.projects.get(params.projectId), `unknown project: ${params.projectId}`);
      return services.sessions.listWorkers({ projectId: params.projectId });
    },

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
    terminateWorker: async ({ params }) => {
      const worker = await services.sessions.archiveWorker(params.workerId);
      const parsed = workerSchema.parse(requireOr404(worker, `unknown worker: ${params.workerId}`));
      services.hub.broadcast({
        type: "worker.status.changed",
        at: services.now().toISOString(),
        projectId: parsed.projectId,
        workerId: parsed.id,
        status: parsed.status,
      });
      return parsed;
    },

    listProjectPullRequests: async ({ params }) => {
      const project = requireOr404(services.projects.get(params.projectId), `unknown project: ${params.projectId}`);
      return services.diffs.listPullRequests(project.id, project.repoUrl);
    },

    getPullRequestDiff: async ({ params }) => {
      const project = requireOr404(services.projects.get(params.projectId), `unknown project: ${params.projectId}`);
      return services.diffs.getDiff(project.id, project.repoUrl, params.prNumber);
    },

    getSettings: () => services.settings.get(),

    updateSettings: ({ body }) => services.settings.update(updateSettingsRequestSchema.parse(body)),

    // Self-update (issues #55, #76): the check result plus the live
    // active-worker count — the webapp disables its update button on the
    // same data the apply endpoint gates with. Cached upstream (≤ hourly
    // gh re-check), fresh worker count every poll.
    getUpdateStatus: async () => {
      const status = await services.update.check();
      return { ...status, activeWorkers: countActiveWorkers(services) };
    },

    /**
     * Apply update (issue #76): gates server-side on zero active workers
     * (never trust the client — a worker spawned since the last poll still
     * aborts cleanly with 409), then spawns the `agentskiss update` shim
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
