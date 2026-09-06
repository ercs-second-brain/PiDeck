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
 * Beyond the webapp contract map, this module also mounts the CLI action
 * routes finalized in issue #9 (documented in agent/README.md):
 * - `GET  /api/status` — daemon liveness
 * - `POST /api/projects/:projectId/spawn` — spawn a worker
 * - `POST /api/sessions/:sessionId/send` — deliver a message into a tmux pane
 */

import type { z } from "zod";
import {
  endpoints,
  registerProjectRequestSchema,
  updateProjectRequestSchema,
  updateSettingsRequestSchema,
  workerSchema,
  type EndpointName,
  type Worker,
} from "@agentskiss/shared";

import { HttpError, Router } from "./router.js";
import { NotFoundError } from "./projects.js";
import type { DaemonServices } from "./context.js";
import { projectSpawnSchema, sessionSendSchema } from "./cli-routes.js";

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
      const deleted = services.projects.delete(params.projectId);
      if (!deleted) throw new NotFoundError(`unknown project: ${params.projectId}`);
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
  };
}

function requireOr404<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new NotFoundError(message);
  return value;
}

// ---------------------------------------------------------------------------
// CLI action routes (agent/README.md: spawn / send / status, finalized in #9)
// ---------------------------------------------------------------------------

/** Terminal (non-failed) worker statuses counted against the concurrency cap. */
const ACTIVE_STATUSES = new Set(["spawning", "running", "awaiting_ci", "fixing_ci", "addressing_review"]);

/**
 * Spawns a worker via the SessionManager: `--issue` workers carry the issue
 * number; freeform (`--prompt` only) workers record `issueNumber: 0` (the
 * shared `workerSchema` documents 0 as the freeform-worker marker).
 *
 * Emits `worker.spawned` on the hub.
 */
export async function spawnWorker(
  services: DaemonServices,
  projectId: string,
  input: { issueNumber?: number; name: string; prompt?: string },
): Promise<Worker> {
  const project = requireOr404(services.projects.get(projectId), `unknown project: ${projectId}`);
  const active = services.sessions.listWorkers({ projectId }).filter((worker) => ACTIVE_STATUSES.has(worker.status));
  // `workerConcurrency` unset = unbounded (issue #14); when set, manual spawns
  // beyond the cap are rejected (the auto-spawn pipeline queues instead).
  const cap = project.settings.workerConcurrency;
  if (cap !== undefined && active.length >= cap) {
    throw new HttpError(
      409,
      `worker concurrency cap reached for project "${projectId}" (${active.length}/${cap} active)`,
    );
  }
  const { worker } = await services.sessions.spawnWorker(projectId, {
    issueNumber: input.issueNumber ?? 0,
    statusMessage: input.prompt !== undefined ? "agent running; initial prompt queued" : undefined,
  });
  if (input.prompt !== undefined) {
    await services.sessions.sendKeys(worker.sessionId, input.prompt, { enter: true });
  }
  const workerParsed = workerSchema.parse(worker);
  services.hub.broadcast({ type: "worker.spawned", at: services.now().toISOString(), worker: workerParsed });
  return workerParsed;
}

/** Delivers a message into a session's tmux pane (typed, then Enter). */
export async function sendToSession(services: DaemonServices, sessionId: string, message: string): Promise<void> {
  const session = services.sessions.listSessions().find((s) => s.id === sessionId);
  if (session === undefined) throw new NotFoundError(`unknown session: ${sessionId}`);
  await services.sessions.sendKeys(sessionId, message, { enter: true });
}

/** Mounts the CLI action routes (status, spawn, send) on the router. */
export function registerCliRoutes(router: Router, services: DaemonServices): void {
  router.add("GET", "/api/status", () => ({
    body: {
      ok: true,
      name: "agentskiss-daemon",
      projects: services.projects.list().length,
      sessions: services.sessions.listSessions().length,
      at: services.now().toISOString(),
    },
  }));

  router.add("POST", "/api/projects/:projectId/spawn", (ctx) =>
    Promise.resolve(projectSpawnSchema.parse(ctx.body)).then((input) =>
      spawnWorker(services, ctx.params["projectId"] as string, input).then((worker) => ({
        status: 201,
        body: worker,
      })),
    ),
  );

  router.add("POST", "/api/sessions/:sessionId/send", (ctx) => {
    const body = sessionSendSchema.parse(ctx.body);
    return sendToSession(services, ctx.params["sessionId"] as string, body.message).then(() => ({
      status: 200,
      body: { ok: true },
    }));
  });
}
