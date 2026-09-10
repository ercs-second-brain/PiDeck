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

import { workerSchema, type Project, type Worker } from "@pideck/shared";

import { countProjectOccupants } from "../sessions/occupancy.js";
import type { DaemonServices } from "./context.js";
import { nodeStatus } from "./node-version.js";
import { HttpError, Router } from "./router.js";
import { NotFoundError } from "./projects.js";
import { requireOr404 } from "./handlers.js";
import { handleAgentKindSpawn } from "./agent-kind-spawn.js";
import { projectSpawnSchema, sessionReportPrSchema, sessionSendSchema } from "./cli-routes.js";
import { buildIssueSpawnPrompt } from "../pipeline/issues/prompts.js";
import { mapRestIssue } from "../github/issues.js";
import { formatRepoRef, parseRepoUrl } from "../github/gh.js";

/**
 * The initial prompt an issue-backed spawn delivers into the fresh pane when
 * the caller supplied none (issue #378, the #266 parity for manual spawns):
 * the orchestrator's canonical invocation (`pideck spawn --project X --issue
 * N --name L`, per the shipped spawn-worker skill) carries no `--prompt`, so
 * before this resolution the worker booted into pi and sat idle — the exact
 * empty-idle-worker bug #266 fixed for auto-spawns, unfixed on the CLI path.
 * The same builder the auto-spawn pipeline uses renders the issue context
 * from the REST-fetched issue; a number that turns out to be a pull request
 * (or any fetch failure) fails the spawn BEFORE the worker exists — never
 * knowingly spawn an idle worker.
 */
async function issueSpawnPrompt(services: DaemonServices, project: Project, issueNumber: number): Promise<string> {
  const ref = parseRepoUrl(project.repoUrl);
  let raw: unknown;
  try {
    raw = await services.gh(project.repoUrl).apiJson(`/repos/${formatRepoRef(ref)}/issues/${issueNumber}`);
  } catch (err) {
    throw new HttpError(
      502,
      `cannot fetch issue #${issueNumber} for the worker's initial prompt (repo ${formatRepoRef(ref)}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const record = mapRestIssue(project.id, raw);
  if (record === null) {
    throw new HttpError(400, `#${issueNumber} in ${formatRepoRef(ref)} is not an issue (it may be a pull request); spawn it freeform with --prompt instead`);
  }
  return buildIssueSpawnPrompt(record.issue);
}

/**
 * Spawns a worker via the SessionManager: `--issue` workers carry the issue
 * number; freeform (`--prompt` only) workers record `issueNumber: 0` (the
 * shared `workerSchema` documents 0 as the freeform-worker marker).
 *
 * Initial prompt resolution (issue #378, #266 parity): an explicit `--prompt`
 * always wins; an issue-backed spawn without one gets the issue's context
 * (the same prompt the auto-spawn pipeline types, issue #266) fetched and
 * built BEFORE the worker exists, so every spawned worker has a prompt to
 * deliver — the orchestrator's issue-backed spawns never boot a pane empty.
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
  // `workerConcurrency` unset/null = unbounded (issues #14, #168); when set,
  // manual spawns beyond the cap are rejected (the auto-spawn pipeline queues
  // instead). Occupancy is the ONE shared predicate (issue #393): active
  // workers + live workerLike kind sessions, identical on every spawn path.
  const cap = project.settings.workerConcurrency;
  const occupants = countProjectOccupants(services.sessions, services.agentKinds, projectId);
  if (cap != null && occupants >= cap) {
    throw new HttpError(
      409,
      `worker concurrency cap reached for project "${projectId}" (${occupants}/${cap} active)`,
    );
  }
  // Issue #378 (#266 parity): the initial prompt is resolved BEFORE the
  // spawn — an explicit `--prompt` wins; an issue-backed spawn without one
  // gets the issue's context (the same prompt the auto-spawn pipeline
  // types) — so the built prompt lands on the worker record (issue #120)
  // and rides the same gate below. A resolution failure (gh fetch, a
  // pull-request number) fails the spawn before any worker exists.
  const prompt = input.prompt ?? (input.issueNumber !== undefined ? await issueSpawnPrompt(services, project, input.issueNumber) : undefined);
  const { worker } = await services.sessions.spawnWorker(projectId, {
    issueNumber: input.issueNumber ?? 0,
    ...(prompt !== undefined ? { statusMessage: "agent running; initial prompt queued", prompt } : {}),
  });
  const piAuth = await services.piAuth.payload();
  if (!piAuth.ready) {
    // Issue #56: never type a prompt into an agent that cannot run, and
    // never leave an unauthenticated worker at `running` — the gate holds
    // the worker at `spawning` with the precise fix in `statusMessage`.
    services.promptGate.queue(worker, prompt);
  } else if (prompt !== undefined) {
    // Issue #56 parity: never type the prompt into an agent that cannot run.
    // Issue #318: even with auth ready, the pane was just created — deliver
    // through the readiness wait + submit confirmation (bare-Enter nudges
    // only; the text is never re-typed). On timeout the prompt is queued on
    // the gate instead; a typed-but-unconfirmed draft stays visible in the
    // composer and must NOT be queued (double delivery).
    const delivered = await services.sessions.deliverPromptWhenReady(worker.sessionId, prompt);
    if (delivered.typed) {
      services.sessions.updateWorkerStatus(worker.id, "running", delivered.accepted
        ? "agent running; initial prompt delivered"
        : "agent running; initial prompt typed (submit unconfirmed)");
    } else {
      services.promptGate.queue(worker, prompt);
    }
  }
  const workerParsed = workerSchema.parse(services.sessions.getWorker(worker.id) ?? worker);
  services.hub.broadcast({ type: "worker.spawned", at: services.now().toISOString(), worker: workerParsed });
  return workerParsed;
}

/**
 * Explicit PR→worker report (`pideck report-pr`, issue #49): the calling
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
    // The installed pi version (issue #223), alongside nodeVersion below:
    // staleness of the agent itself becomes observable from the API. Run
    // concurrently with the auth probe so a cold status pays one round trip,
    // not two (issue #100: the status path never serializes pi spawns).
    const [pi, piVersion] = await Promise.all([services.piAuth.payload(), services.piAuth.version()]);
    return {
      body: {
        ok: true,
        name: "pideck-daemon",
        projects: services.projects.list().length,
        sessions: services.sessions.listSessions().length,
        piReady: pi.ready,
        piProviders: pi.providers,
        piVersion,
        // Node runtime vs pi's requirement (issue #202): a daemon booted on
        // an old private node spawns pi sessions that crash on first request.
        ...nodeStatus(),
        // Runtime health (issue #100): event-loop lag, memory, uptime —
        // first-line diagnostics for slow/unstable installs.
        ...services.runtimeStats.snapshot(),
        at: services.now().toISOString(),
      },
    };
  });

  registerPiAuthRoute(router, services);

  router.add("POST", "/api/projects/:projectId/spawn", (ctx) =>
    Promise.resolve(projectSpawnSchema.parse(ctx.body)).then((input) => {
      const projectId = ctx.params["projectId"] as string;
      // One route, two spawn types (docs/agent-kinds.md): a `kind` body
      // spawns a preset-prompt agent-kind session (the response is a
      // Session — agent-kind sessions are not workers); anything else is a
      // worker spawn (the response is a Worker).
      if (input.kind !== undefined) {
        return handleAgentKindSpawn(services, projectId, { ...input, kind: input.kind }).then((session) => ({
          status: 201,
          body: session,
        }));
      }
      return spawnWorker(services, projectId, input).then((worker) => ({
        status: 201,
        body: worker,
      }));
    }),
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
