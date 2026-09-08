/**
 * CLI action routes (agent/README.md: spawn / send / status, finalized in #9)
 * and the pi-auth probe route.
 *
 * - `GET  /api/status` — daemon liveness
 * - `POST /api/projects/:projectId/spawn` — spawn a worker
 * - `POST /api/sessions/:sessionId/send` — deliver a message into a tmux pane
 * - `POST /api/sessions/report-pr` — worker session self-reports its PR (issue #49)
 * - `GET  /api/pi-auth` — pi provider readiness probe (issue #57)
 */

import { ACTIVE_WORKER_STATUSES, workerSchema, type Worker } from "@agentskiss/shared";

import type { DaemonServices } from "./context.js";
import { HttpError, Router } from "./router.js";
import { NotFoundError } from "./projects.js";
import { requireOr404 } from "./handlers.js";
import { projectSpawnSchema, sessionReportPrSchema, sessionSendSchema } from "./cli-routes.js";

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
    ...(input.prompt !== undefined ? { statusMessage: "agent running; initial prompt queued", prompt: input.prompt } : {}),
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
  const session = requireOr404(
    services.sessions.listSessions().find((s) => s.tmuxSession === input.tmuxSession),
    `unknown tmux session: ${input.tmuxSession}`,
  );
  if (session.role !== "worker" || session.workerId === null) {
    throw new HttpError(403, `session ${session.id} is not a worker session; report-pr is worker-only`);
  }
  const worker = requireOr404(
    services.sessions.getWorker(session.workerId),
    `worker ${session.workerId} (session ${session.id}) not found`,
  );
  return workerSchema.parse(services.sessions.setWorkerPr(worker.id, input.prNumber));
}

/** Delivers a message into a session's tmux pane (typed, then Enter). */
async function sendToSession(services: DaemonServices, sessionId: string, message: string): Promise<void> {
  const session = services.sessions.listSessions().find((s) => s.id === sessionId);
  if (session === undefined) throw new NotFoundError(`unknown session: ${sessionId}`);
  await services.sessions.sendKeys(sessionId, message, { enter: true });
}

/**
 * Mounts `GET /api/pi-auth` on the router. Non-contract route like
 * `/api/gh-auth`: a daemon-side capability probe (which pi providers have
 * ready credentials, and which startup model pi is configured with), not a
 * resource API. The shape is still contracted in the shared package
 * (`piAuthSchema`) so the webapp cannot drift from the daemon.
 */
function registerPiAuthRoute(router: Router, services: DaemonServices): void {
  router.add("GET", "/api/pi-auth", () => services.piAuth.payload().then((body) => ({ body })));
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
        // Runtime health (issue #100): event-loop lag, memory, uptime —
        // first-line diagnostics for slow/unstable installs.
        ...services.runtimeStats.snapshot(),
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
