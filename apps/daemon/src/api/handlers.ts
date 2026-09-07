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
 * - `POST /api/sessions/report-pr` — worker session self-reports its PR (issue #49)
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
  type Worker,
} from "@agentskiss/shared";

import { HttpError, Router } from "./router.js";
import { NotFoundError } from "./projects.js";
import type { DaemonServices } from "./context.js";
import { projectSpawnSchema, sessionReportPrSchema, sessionSendSchema } from "./cli-routes.js";
import { GhClient, getAuthStatus, getRepoCreationPermissions } from "../github/index.js";

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
      if (worker === null) throw new NotFoundError(`unknown worker: ${params.workerId}`);
      const parsed = workerSchema.parse(worker);
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

    // Self-update check (issue #55): local source vs upstream via gh. Never
    // throws — failures come back as a status body with `error` set.
    getUpdateStatus: () => services.update.check(),
  };
}

function requireOr404<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new NotFoundError(message);
  return value;
}

// ---------------------------------------------------------------------------
// CLI action routes (agent/README.md: spawn / send / status, finalized in #9)
// ---------------------------------------------------------------------------

/**
 * Spawns a worker via the SessionManager: `--issue` workers carry the issue
 * number; freeform (`--prompt` only) workers record `issueNumber: 0` (the
 * shared `workerSchema` documents 0 as the freeform-worker marker).
 *
 * Initial-prompt readiness gate (issue #56): the prompt is typed into the
 * pane only when the pi auth probe reports a ready provider. When it does
 * not, the worker is held at the truthful `spawning` status with a precise
 * `statusMessage`, and the prompt is queued on the {@link PromptGate} —
 * delivered automatically once auth becomes ready. An unauthenticated
 * worker never reports `running`, and its prompt is never swallowed.
 *
 * Emits `worker.spawned` on the hub.
 */
export async function spawnWorker(
  services: DaemonServices,
  projectId: string,
  input: { issueNumber?: number; name: string; prompt?: string },
): Promise<Worker> {
  const project = requireOr404(services.projects.get(projectId), `unknown project: ${projectId}`);
  const active = services.sessions.listWorkers({ projectId }).filter((worker) => ACTIVE_WORKER_STATUSES.has(worker.status));
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
    ...(input.prompt !== undefined ? { statusMessage: "agent running; initial prompt queued" } : {}),
  });
  const piAuth = await services.piAuth.payload();
  if (!piAuth.ready) {
    // Issue #56: never type a prompt into an agent that cannot run, and
    // never leave an unauthenticated worker at `running` — the gate holds
    // the worker at `spawning` with the precise fix in `statusMessage`.
    services.promptGate.queue(worker, input.prompt);
  } else if (input.prompt !== undefined) {
    await services.sessions.sendKeys(worker.sessionId, input.prompt, { enter: true });
    services.sessions.updateWorkerStatus(worker.id, "running", "agent running; initial prompt delivered");
  }
  const workerParsed = workerSchema.parse(services.sessions.getWorker(worker.id) ?? worker);
  services.hub.broadcast({ type: "worker.spawned", at: services.now().toISOString(), worker: workerParsed });
  return workerParsed;
}

// ---------------------------------------------------------------------------
// gh auth probe (webapp onboarding wizard, issue #13)
// ---------------------------------------------------------------------------

/** Response body of `GET /api/gh-auth`: gh auth status + repo-creation permission. */
export interface GhAuthPayload {
  authenticated: boolean;
  /** Login of the authenticated user, `null` when unauthenticated. */
  login: string | null;
  tokenSource: string;
  scopes: string[];
  canCreateRepos: "yes" | "no" | "unknown";
  canCreatePrivateRepos: "yes" | "no" | "unknown";
  canCreatePublicRepos: "yes" | "no" | "unknown";
  /** Human-readable explanation, suitable for surfacing in the UI. */
  detail: string;
}

/**
 * Probes the daemon's `gh` authentication and repo-creation permissions
 * (github module's auth check from #22) for the webapp onboarding wizard.
 * Non-contract route (like `/api/status`): deliberately not in the shared
 * endpoint map — it is a daemon-side capability probe, not a resource API.
 */
export async function ghAuthPayload(gh: GhClient = new GhClient()): Promise<GhAuthPayload> {
  const [status, permissions] = await Promise.all([getAuthStatus(gh), getRepoCreationPermissions(gh)]);
  return {
    authenticated: status.authenticated,
    login: status.login,
    tokenSource: status.tokenSource,
    scopes: status.scopes,
    canCreateRepos: permissions.canCreateRepos,
    canCreatePrivateRepos: permissions.canCreatePrivateRepos,
    canCreatePublicRepos: permissions.canCreatePublicRepos,
    detail: permissions.detail,
  };
}

/** Mounts `GET /api/gh-auth` on the router. */
export function registerGhAuthRoute(router: Router): void {
  router.add("GET", "/api/gh-auth", () => ghAuthPayload().then((body) => ({ body })));
}

// ---------------------------------------------------------------------------
// pi auth probe (webapp onboarding wizard + spawn readiness gate, issue #57)
// ---------------------------------------------------------------------------

/**
 * Mounts `GET /api/pi-auth` on the router. Non-contract route like
 * `/api/gh-auth`: a daemon-side capability probe (which pi providers have
 * ready credentials, and which startup model pi is configured with), not a
 * resource API. The shape is still contracted in the shared package
 * (`piAuthSchema`) so the webapp cannot drift from the daemon.
 */
export function registerPiAuthRoute(router: Router, services: DaemonServices): void {
  router.add("GET", "/api/pi-auth", () => services.piAuth.payload().then((body) => ({ body })));
}

/**
 * Explicit PR→worker report (`agentskiss report-pr`, issue #49): the calling
 * worker session reports the PR it opened. The CLI self-identifies the tmux
 * session from its own pane context, so the daemon resolves the worker
 * behind that session — no session id to guess or mistype.
 *
 * Precedence (issue #49): an explicit report **wins**. The wiring's
 * title/branch heuristic (`associateWorkerPr`) stays as the fallback and
 * only ever fills workers whose `prNumber` is still null; `setWorkerPr`
 * overwrites any stale heuristic value, and the heuristic never re-claims a
 * worker that already has a PR recorded.
 */
export async function reportWorkerPr(
  services: DaemonServices,
  input: { tmuxSession: string; prNumber: number },
): Promise<Worker> {
  const session = services.sessions.listSessions().find((s) => s.tmuxSession === input.tmuxSession);
  if (session === undefined) throw new NotFoundError(`unknown tmux session: ${input.tmuxSession}`);
  if (session.role !== "worker" || session.workerId === null) {
    throw new HttpError(403, `session ${session.id} is not a worker session; report-pr is worker-only`);
  }
  const worker = services.sessions.getWorker(session.workerId);
  if (worker === undefined) throw new NotFoundError(`worker ${session.workerId} (session ${session.id}) not found`);
  return workerSchema.parse(services.sessions.setWorkerPr(worker.id, input.prNumber));
}

/** Delivers a message into a session's tmux pane (typed, then Enter). */
export async function sendToSession(services: DaemonServices, sessionId: string, message: string): Promise<void> {
  const session = services.sessions.listSessions().find((s) => s.id === sessionId);
  if (session === undefined) throw new NotFoundError(`unknown session: ${sessionId}`);
  await services.sessions.sendKeys(sessionId, message, { enter: true });
}

/** Mounts the CLI action routes (status, spawn, send, pi-auth) on the router. */
export function registerCliRoutes(router: Router, services: DaemonServices): void {
  router.add("GET", "/api/status", async () => {
    // pi auth readiness in the status payload (issue #57): an unauthenticated
    // daemon says so here (and warns at startup) instead of failing silently
    // when the first worker spawn queues its prompt.
    const pi = await services.piAuth.payload();
    return {
      body: {
        ok: true,
        name: "agentskiss-daemon",
        projects: services.projects.list().length,
        sessions: services.sessions.listSessions().length,
        piReady: pi.ready,
        piProviders: pi.providers,
        at: services.now().toISOString(),
      },
    };
  });

  registerPiAuthRoute(router, services);

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

  router.add("POST", "/api/sessions/report-pr", (ctx) => {
    const body = sessionReportPrSchema.parse(ctx.body);
    return reportWorkerPr(services, body).then((worker) => ({
      status: 200,
      body: worker,
    }));
  });
}
