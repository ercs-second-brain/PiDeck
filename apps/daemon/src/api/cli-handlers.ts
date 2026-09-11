/**
 * CLI action routes (agent/README.md: spawn / send / status, finalized in #9)
 * and the pi-auth probe route.
 *
 * - `GET  /api/status` — daemon liveness
 * - `POST /api/projects/:projectId/spawn` — spawn a worker
 * - `POST /api/projects/:projectId/assign` — assign an issue to the gh account
 *   (auto-triggers a worker; unassign + re-assign when already assigned, #491)
 * - `POST /api/sessions/:sessionId/send` — deliver a message into a tmux pane
 * - `GET  /api/pi-auth` — pi provider readiness probe (issue #57)
 *
 * PR→worker association has no CLI route (issue #439): claiming is
 * deterministic daemon code (pipeline/issue-refs.ts), so there is no
 * worker self-report path at all.
 */

import { workerSchema, type Worker } from "@pideck/shared";

import { countProjectOccupants } from "../sessions/occupancy.js";
import { getAuthStatus } from "../github/auth.js";
import { mapRestIssue } from "../github/issues.js";
import { formatRepoRef, parseRepoUrl } from "../github/gh.js";
import type { DaemonServices } from "./context.js";
import { nodeStatus } from "./node-version.js";
import { HttpError, Router } from "./router.js";
import { NotFoundError } from "./projects.js";
import { requireOr404 } from "./handlers.js";
import { handleAgentKindSpawn } from "./agent-kind-spawn.js";
import { deliverSpawnPrompt } from "../agent/prompt-gate.js";
import { projectAssignSchema, projectSpawnSchema, sessionSendSchema, type ProjectAssignResult } from "./cli-routes.js";
import { issueSpawnPrompt, retaskReusableWorker } from "./spawn-reuse.js";

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
 * The delivery itself is the ONE shared spawn-path dance
 * ({@link deliverSpawnPrompt}, issues #56/#318/#378; consolidated from four
 * drifted copies in issue #426) — see agent/prompt-gate.ts.
 *
 * Emits `worker.spawned` on the hub.
 */
export async function spawnWorker(
  services: DaemonServices,
  projectId: string,
  input: { issueNumber?: number; name: string; prompt?: string; lane?: string },
): Promise<Worker> {
  const project = requireOr404(services.projects.get(projectId), `unknown project: ${projectId}`);
  // Issue #378 (#266 parity): the initial prompt is resolved BEFORE the
  // spawn — an explicit `--prompt` wins; an issue-backed spawn without one
  // gets the issue's context (the same prompt the auto-spawn pipeline
  // types) — so the built prompt lands on the worker record (issue #120)
  // and rides the same gate below. A resolution failure (gh fetch, a
  // pull-request number) fails the spawn before any worker exists.
  const prompt = input.prompt ?? (input.issueNumber !== undefined ? await issueSpawnPrompt(services, project, input.issueNumber) : undefined);

  // Issue #471 — idle same-lane worker reuse: consulted BEFORE the cap
  // check and any fresh spawn. Slot-neutral (the reused worker already
  // occupies its slot), so a capped project's follow-on still lands. The
  // threshold resolves per project, read fresh on every decision; the
  // mechanics (retask + gated prompt delivery + broadcast) live in
  // {@link retaskReusableWorker}.
  if (input.lane !== undefined) {
    const reused = await retaskReusableWorker(services, project, projectId, { issueNumber: input.issueNumber, lane: input.lane, prompt });
    if (reused !== null) return reused;
  }

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
  const { worker } = await services.sessions.spawnWorker(projectId, {
    issueNumber: input.issueNumber ?? 0,
    // Issue #471: the spawn request's conceptual lane rides onto the worker
    // record — the idle-reuse key for same-lane follow-on tasks.
    ...(input.lane !== undefined ? { lane: input.lane } : {}),
    ...(prompt !== undefined ? { statusMessage: "agent running; initial prompt queued", prompt } : {}),
  });
  // The one gated delivery dance shared with every other spawn path
  // (issues #56/#318/#378, consolidated in issue #426): pi-auth probe →
  // queue on the gate when unready (never type a prompt into an agent
  // that cannot run), else the #318 readiness wait + exactly-once type +
  // submit confirmation — a pane that never readies is queued for a
  // retry, a typed-but-unconfirmed draft is NOT (it would double-deliver).
  // Errors propagate: the awaited route fails the spawn request.
  await deliverSpawnPrompt(
    services.sessions,
    services.promptGate,
    () => services.piAuth.payload().then((piAuth) => piAuth.ready),
    { kind: "worker", worker },
    prompt,
  );
  const workerParsed = workerSchema.parse(services.sessions.getWorker(worker.id) ?? worker);
  services.hub.broadcast({ type: "worker.spawned", at: services.now().toISOString(), worker: workerParsed });
  return workerParsed;
}

/** Delivers a message into a session's tmux pane (typed, then Enter). */
async function sendToSession(services: DaemonServices, sessionId: string, message: string): Promise<void> {
  const session = services.sessions.listSessions().find((s) => s.id === sessionId);
  if (session === undefined) throw new NotFoundError(`unknown session: ${sessionId}`);
  await services.sessions.sendKeys(sessionId, message, { enter: true });
}

/**
 * Assigns an issue to the daemon's gh account (issue #491) — the ONE way
 * agents trigger a worker for an existing issue: assignment-driven spawning
 * (issue #416) reacts to the `issue.assigned` watcher transition and the
 * issue pipeline spawns, so the assign route never spawns a worker itself.
 *
 * Re-trigger semantics (issue #491): GitHub fires `issue.assigned` only on a
 * transition, so re-assigning an already-assigned issue is a no-op up there.
 * When the gh account is already assigned, the route first removes it (the
 * watcher then reports `issue.unassigned`) and re-adds it — the re-assignment
 * re-triggers the worker. Otherwise it just assigns.
 *
 * Re-trigger delivery (issue #509): the DELETE and the POST usually land
 * inside one watcher poll window, so the watcher diffs two identical
 * assignee sets and emits nothing — the re-trigger would be silently lost.
 * After both writes succeed the route therefore synthesizes the
 * `issue.unassigned` + `issue.assigned` pair a straddling poll would have
 * produced and routes it through the same entry point the watchers and the
 * catch-up sweep use: retract (archive the old worker, clear the dedupe
 * mark) then the normal spawn matrix. Both events are needed — `assigned`
 * alone would be swallowed by the dedupe mark while the old worker still
 * runs. Double delivery is safe: when a poll DOES straddle the writes, the
 * watcher's real unassigned is a no-op retract and its assigned hits the
 * dedupe mark set here — exactly one fresh worker either way.
 *
 * The route reports `retriggered: true` for the unassign+re-assign path so
 * the CLI output can say which of the two happened.
 */
export async function assignIssue(
  services: DaemonServices,
  projectId: string,
  issueNumber: number,
): Promise<ProjectAssignResult> {
  const project = requireOr404(services.projects.get(projectId), `unknown project: ${projectId}`);
  const ref = parseRepoUrl(project.repoUrl);
  const gh = services.gh(project.repoUrl);

  // The assignee is the daemon's own gh account (the one the watcher polls
  // with): resolving it first also fails fast when gh is unauthenticated.
  const auth = await getAuthStatus(gh);
  if (!auth.authenticated || auth.login === null) {
    throw new HttpError(409, "gh is not authenticated; run 'gh auth login' (or set GH_TOKEN/GITHUB_TOKEN) on the daemon host to assign issues");
  }
  const login = auth.login;

  // The current-assignment check reads the issue itself: an unknown number,
  // a pull-request number (the issues endpoint also serves PRs), or a gh
  // failure all fail the route before any mutation.
  let raw: unknown;
  try {
    raw = await gh.apiJson(`/repos/${formatRepoRef(ref)}/issues/${issueNumber}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new HttpError(502, `cannot fetch issue #${issueNumber} (repo ${formatRepoRef(ref)}): ${detail}`);
  }
  const record = mapRestIssue(project.id, raw);
  if (record === null) {
    throw new HttpError(400, `#${issueNumber} in ${formatRepoRef(ref)} is a pull request, not an issue — assign works on issues only`);
  }

  const assigneesPath = `/repos/${formatRepoRef(ref)}/issues/${issueNumber}/assignees`;
  const alreadyAssigned = record.assignees.includes(login);
  if (alreadyAssigned) {
    // Unassign first so the re-assignment below is a fresh `issue.assigned`
    // transition (the watcher fires on assignee-count growth, not on no-op
    // writes of the same assignee set).
    try {
      await gh.exec(["api", "--method", "DELETE", assigneesPath, "-f", `assignees[]=${login}`]);
    } catch (err) {
      throw new HttpError(
        502,
        `cannot unassign ${login} from issue #${issueNumber} (repo ${formatRepoRef(ref)}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  try {
    await gh.apiPost(assigneesPath, { assignees: [login] });
  } catch (err) {
    throw new HttpError(
      502,
      `cannot assign ${login} to issue #${issueNumber} (repo ${formatRepoRef(ref)}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (alreadyAssigned) {
    // Issue #509: replay the unassign→re-assign transition pair the watcher
    // may have missed (both writes inside one poll window — it diffs two
    // identical assignee sets and emits nothing). Synthesized through the
    // same router the watchers emit into; dropped when the automation is
    // stopped, same as a watcher being down. The unassigned event carries
    // the cleared assignee for entity fidelity with the watcher's event.
    const at = services.now().toISOString();
    services.automation.handleWatcherEvent(projectId, {
      type: "issue.unassigned",
      at,
      issue: { ...record.issue, assignee: null },
    });
    services.automation.handleWatcherEvent(projectId, { type: "issue.assigned", at, issue: record.issue });
  }
  return { ok: true, issueNumber, assignee: login, retriggered: alreadyAssigned };
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

  // Issue #491: assignment is the worker trigger for existing issues — the
  // route mutates the GitHub issue only; the issue pipeline spawns.
  router.add("POST", "/api/projects/:projectId/assign", (ctx) =>
    Promise.resolve(projectAssignSchema.parse(ctx.body)).then((input) =>
      assignIssue(services, ctx.params["projectId"] as string, input.issueNumber).then((result) => ({
        status: 200,
        body: result,
      })),
    ),
  );
}
