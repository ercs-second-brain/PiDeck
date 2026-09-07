/**
 * Wiring tests for the GitHub automation loop (issue #46): the daemon
 * context must construct the watcher + issue/PR pipelines so that
 *
 * - a watcher event for a fresh unblocked issue spawns a worker and emits
 *   kanban events on the WS hub (`worker.spawned`, `kanban.card.moved`);
 * - a PR watcher event reaches the PR loop (worker association via the
 *   session registry + tracker, red-CI fix prompt through tmux);
 * - `stop()` (the SIGTERM path) halts all polling and event routing first.
 *
 * Uses the same fake gh/git/tmux harness as the API-layer tests; watcher
 * events are dispatched synthetically through
 * `automation.handleWatcherEvent` (the same router the real watchers emit
 * into), so no network or live GitHub is involved.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Issue, KanbanUpdateEvent, PullRequest } from "@agentskiss/shared";

import { testDaemon, type FakeGhRoutes, type TestDaemon } from "../api/testutil.js";
import type { GithubAutomation } from "./wiring.js";
import { CATCH_UP_BATCH_SIZE, watcherOptionsFromEnv } from "./wiring.js";

const REPO_URL = "https://github.com/octo/repo";
const PROJECT = "octo-repo";
const AUTO_USER = "octo-bot";
const NOW = "2026-09-06T12:00:00.000Z";

// Poll interval so large that the running loops never tick again within a
// test: every GitHub interaction below is driven explicitly.
const NO_TICK = 3_600_000;

/** Baseline routes: empty issue/PR snapshots so start() has nothing to see. */
function emptyRoutes(): FakeGhRoutes & { api: Record<string, unknown>; graphql: Record<string, unknown> } {
  return {
    api: {
      "/repos/octo/repo/issues": [],
      "/repos/octo/repo/pulls": [],
    },
    graphql: {
      // listOpenPullRequestsBatched (watcher): empty open-PR page.
      "pullRequests(first:": {
        repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
      },
      // GhBlockerResolver (spawn matrix): REST-mapped issues carry no inline
      // blocker detail, so the pipeline resolves blockedBy via GraphQL.
      "blockedBy(first:": {
        repository: {
          issue: { blockedBy: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
        },
      },
    },
  };
}

function makeIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    projectId: PROJECT,
    number,
    title: `Issue ${number}`,
    state: "open",
    blockedBy: [],
    blockers: [], // inline detail: the spawn pipeline never calls the blocker resolver
    assignee: null,
    url: `https://github.com/octo/repo/issues/${number}`,
    updatedAt: NOW,
    ...overrides,
  };
}

function makePullRequest(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    projectId: PROJECT,
    number,
    title: `PR ${number}`,
    state: "open",
    ciStatus: "unknown",
    reviewState: "none",
    headBranch: `feature-${number}`,
    baseBranch: "main",
    author: AUTO_USER,
    url: `https://github.com/octo/repo/pull/${number}`,
    updatedAt: NOW,
    ...overrides,
  };
}

/** REST pull payload (mapRestPull shape) for the PR pipeline's polls. */
function restPull(number: number, sha: string): Record<string, unknown> {
  return {
    number,
    title: `PR ${number}`,
    state: "open",
    merged_at: null,
    user: { login: AUTO_USER },
    head: { ref: `feature-${number}`, sha },
    base: { ref: "main" },
    html_url: `https://github.com/octo/repo/pull/${number}`,
    updated_at: NOW,
  };
}

async function registeredDaemon(ghRoutes: FakeGhRoutes = emptyRoutes()): Promise<TestDaemon & { automation: GithubAutomation }> {
  const daemon = testDaemon(ghRoutes, { watcherPollIntervalMs: NO_TICK });
  await daemon.services.projects.register({
    mode: "clone",
    repoUrl: REPO_URL,
    settings: { autoAgentUsername: AUTO_USER },
  });
  return { ...daemon, automation: daemon.services.automation };
}

function broadcasts(daemon: TestDaemon): KanbanUpdateEvent[] {
  const events: KanbanUpdateEvent[] = [];
  vi.spyOn(daemon.services.hub, "broadcast").mockImplementation((event) => {
    events.push(event);
  });
  return events;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

let active: TestDaemon | undefined;
afterEach(() => {
  active?.services.automation.stop();
  active = undefined;
});

// ---------------------------------------------------------------------------
// Issue → auto-spawn
// ---------------------------------------------------------------------------

describe("GithubAutomation (issue #46 wiring)", () => {
  it("spawns a worker for a fresh unblocked issue event and emits kanban events on the hub", async () => {
    const daemon = await registeredDaemon();
    active = daemon;
    const events = broadcasts(daemon);
    await daemon.services.automation.start();

    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "issue.created",
      at: NOW,
      issue: makeIssue(46),
    });
    await flush();

    // Worker tmux session + registry record exist with no manual action.
    const workers = daemon.services.registry.listWorkers({ projectId: PROJECT });
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({ issueNumber: 46, status: "running" });

    // Hub fan-out: worker.spawned + kanban.card.moved (backlog → in_progress).
    expect(events.some((e) => e.type === "worker.spawned" && e.worker.id === workers[0]!.id)).toBe(true);
    const moved = events.find((e) => e.type === "kanban.card.moved");
    expect(moved).toMatchObject({
      type: "kanban.card.moved",
      projectId: PROJECT,
      cardId: `issue-${PROJECT}-46`,
      from: "backlog",
      to: "in_progress",
      card: { kind: "issue", number: 46, column: "in_progress", workerId: workers[0]!.id },
    });

    // Dedupe: a redelivered event does not spawn a second worker.
    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "issue.created",
      at: NOW,
      issue: makeIssue(46),
    });
    await flush();
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(1);
  });

  it("does not auto-spawn for a project without auto-spawn enabled", async () => {
    const daemon = testDaemon(emptyRoutes(), { watcherPollIntervalMs: NO_TICK });
    active = daemon;
    await daemon.services.projects.register({ mode: "clone", repoUrl: REPO_URL }); // no autoAgentUsername
    broadcasts(daemon);
    await daemon.services.automation.start();
    expect(daemon.services.automation.watchedProjectIds).toEqual([PROJECT]); // PR loop only, no issue watcher

    daemon.services.automation.handleWatcherEvent(PROJECT, { type: "issue.created", at: NOW, issue: makeIssue(1) });
    await flush();
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(0);
  });

  it("drops watcher events after stop() (shutdown ordering)", async () => {
    const daemon = await registeredDaemon();
    active = daemon;
    broadcasts(daemon);
    await daemon.services.automation.start();
    expect(daemon.services.automation.isRunning).toBe(true);

    daemon.automation.stop();
    expect(daemon.services.automation.isRunning).toBe(false);
    expect(daemon.services.automation.watchedProjectIds).toEqual([]);

    // SIGTERM ordering: after automation.stop() no further spawn/prompt
    // work is started, even if a late watcher event is delivered.
    daemon.services.automation.handleWatcherEvent(PROJECT, { type: "issue.created", at: NOW, issue: makeIssue(46) });
    await flush();
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(0);
  });

  it("start() baselines the issue watcher so the existing backlog does not mass-spawn", async () => {
    // A pre-existing open issue authored by the auto-agent user would be
    // emitted as `issue.created` by the watcher's first poll; the baseline
    // sweep at start() must discard it.
    const daemon = await registeredDaemon({
      api: {
        "/repos/octo/repo/issues": [
          {
            number: 46,
            title: "Old backlog issue",
            state: "open",
            user: { login: AUTO_USER },
            assignee: null,
            assignees: [],
            html_url: "https://github.com/octo/repo/issues/46",
            updated_at: NOW,
          },
        ],
        "/repos/octo/repo/pulls": [],
      },
      graphql: emptyRoutes().graphql,
    });
    active = daemon;
    broadcasts(daemon);
    await daemon.services.automation.start();
    await flush();

    expect(daemon.services.automation.watchedProjectIds).toEqual([PROJECT]);
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(0);
  });

  it("watches projects registered while the daemon is running (resync)", async () => {
    const daemon = await registeredDaemon();
    active = daemon;
    await daemon.services.automation.start();
    expect(daemon.services.automation.watchedProjectIds).toEqual([PROJECT]);

    await daemon.services.projects.register({
      mode: "clone",
      repoUrl: "https://github.com/octo/two",
      settings: { autoAgentUsername: AUTO_USER },
    });
    expect(daemon.automation.watchedProjectIds.sort()).toEqual([PROJECT, "octo-two"]);
  });

  it("is inert when disabled (AGENTSKISS_WATCHER_ENABLED=0 semantics)", async () => {
    const daemon = testDaemon(emptyRoutes(), { watcherEnabled: false, watcherPollIntervalMs: NO_TICK });
    active = daemon;
    await daemon.services.projects.register({
      mode: "clone",
      repoUrl: REPO_URL,
      settings: { autoAgentUsername: AUTO_USER },
    });
    broadcasts(daemon);
    await daemon.services.automation.start();

    expect(daemon.services.automation.isRunning).toBe(false);
    expect(daemon.services.automation.watchedProjectIds).toEqual([]);
    daemon.services.automation.handleWatcherEvent(PROJECT, { type: "issue.created", at: NOW, issue: makeIssue(46) });
    await flush();
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // PR → lifecycle loop
  // -------------------------------------------------------------------------

  it("associates a worker-PR event with its worker and drives a red PR to a CI-fix prompt", async () => {
    const daemon = await registeredDaemon({
      ...emptyRoutes(),
      api: {
        ...emptyRoutes().api,
        // PR pipeline discovery + per-PR state (red CI on sha-1).
        "/repos/octo/repo/pulls": [restPull(7, "sha-1")],
        "/repos/octo/repo/pulls/7": restPull(7, "sha-1"),
        "/repos/octo/repo/commits/sha-1/check-runs": {
          total_count: 1,
          check_runs: [{ status: "completed", conclusion: "failure" }],
        },
        "/repos/octo/repo/pulls/7/reviews": [],
        "/repos/octo/repo/pulls/7/comments": [],
      },
    });
    active = daemon;
    const events = broadcasts(daemon);
    await daemon.services.automation.start();

    // Worker for issue #46 exists but has not reported a PR yet.
    const { worker } = await daemon.services.sessions.spawnWorker(PROJECT, { issueNumber: 46 });
    expect(worker.prNumber).toBeNull();

    // PR watcher event: the PR's title references the worker's issue → the
    // wiring records the association on the session registry (setWorkerPr)
    // and the PR loop tracks it, emitting the initial card.
    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "pull_request.opened",
      at: NOW,
      pullRequest: makePullRequest(7, { title: "Resolve #46: fix the loop", headBranch: "issue-46-fix" }),
    });

    expect(daemon.services.registry.getWorker(worker.id)!.prNumber).toBe(7);
    const trackedCard = events.find((e) => e.type === "kanban.card.moved" && e.cardId === `pr:${PROJECT}:7`);
    expect(trackedCard).toMatchObject({ card: { kind: "pull_request", number: 7, column: "in_review", workerId: worker.id } });

    // The loop drives the red PR: a CI-fix prompt goes to the worker's
    // tmux session, bounded attempts start at 1, and the worker status
    // change reaches the hub.
    const sendKeys = vi.spyOn(daemon.services.sessions, "sendKeys");
    await daemon.automation.pollPrPipeline(PROJECT);

    expect(sendKeys).toHaveBeenCalledTimes(1);
    const [sessionId, prompt] = sendKeys.mock.calls[0] ?? [];
    expect(sessionId).toBe(worker.sessionId);
    expect(String(prompt)).toContain("CI is failing on your PR #7");
    expect(String(prompt)).toContain("attempt 1 of ");
    expect(events.some((e) => e.type === "worker.status.changed" && e.status === "fixing_ci")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Knobs
  // -------------------------------------------------------------------------

  it("resolves the watcher knobs from env with sane defaults", () => {
    expect(watcherOptionsFromEnv({})).toEqual({ enabled: true, pollIntervalMs: 30_000 });
    expect(watcherOptionsFromEnv({ AGENTSKISS_WATCHER_ENABLED: "0" })).toEqual({ enabled: false, pollIntervalMs: 30_000 });
    expect(watcherOptionsFromEnv({ AGENTSKISS_WATCHER_ENABLED: "false" })).toEqual({ enabled: false, pollIntervalMs: 30_000 });
    expect(watcherOptionsFromEnv({ AGENTSKISS_WATCHER_ENABLED: "1" })).toEqual({ enabled: true, pollIntervalMs: 30_000 });
    expect(watcherOptionsFromEnv({ AGENTSKISS_WATCHER_POLL_INTERVAL_MS: "120000" })).toEqual({
      enabled: true,
      pollIntervalMs: 120_000,
    });
    // Invalid values fall back to the default instead of hammering the API.
    expect(watcherOptionsFromEnv({ AGENTSKISS_WATCHER_POLL_INTERVAL_MS: "-5" })).toEqual({
      enabled: true,
      pollIntervalMs: 30_000,
    });
    // Explicit options win over env.
    expect(
      watcherOptionsFromEnv({ AGENTSKISS_WATCHER_POLL_INTERVAL_MS: "120000" }, { enabled: false, pollIntervalMs: 1000 }),
    ).toEqual({ enabled: false, pollIntervalMs: 1000 });
  });
});

// ---------------------------------------------------------------------------
// Issue catch-up sweep (issue #50)
// ---------------------------------------------------------------------------

/** REST issue payload (mapRestIssue shape) for the baseline/catch-up routes. */
function restIssue(number: number, author: string = AUTO_USER, assignees: string[] = []): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    user: { login: author },
    assignee: assignees[0] !== undefined ? { login: assignees[0] } : null,
    assignees: assignees.map((login) => ({ login })),
    html_url: `https://github.com/octo/repo/issues/${number}`,
    updated_at: NOW,
  };
}

/** Issues route in GitHub's `sort=created&direction=desc` order (newest first). */
function issuesNewestFirst(...numbers: number[]): Record<string, unknown>[] {
  return numbers.map((number) => restIssue(number));
}

function cursorState(stateDir: string): number | null {
  const raw = JSON.parse(readFileSync(path.join(stateDir, "issue-cursor", `${PROJECT}.json`), "utf8")) as {
    lastSeenIssueNumber?: number;
  };
  return raw.lastSeenIssueNumber ?? null;
}

/** Registers the project (with auto-spawn settings) without starting the automation. */
async function registeredRoutesDaemon(
  routes: FakeGhRoutes,
  settings: { autoAgentUsername: string | null; workerConcurrency?: number } = { autoAgentUsername: AUTO_USER },
): Promise<TestDaemon & { automation: GithubAutomation }> {
  const daemon = testDaemon(routes, { watcherPollIntervalMs: NO_TICK });
  active = daemon;
  await daemon.services.projects.register({ mode: "clone", repoUrl: REPO_URL, settings });
  return { ...daemon, automation: daemon.services.automation };
}

describe("GithubAutomation issue catch-up (issue #50)", () => {
  it("auto-spawns an issue created while the daemon was down and persists the cursor across restarts", async () => {
    const routes = emptyRoutes();
    routes.api["/repos/octo/repo/issues"] = issuesNewestFirst(45);
    const daemon = await registeredRoutesDaemon(routes);
    broadcasts(daemon);
    await daemon.automation.start();
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(0);
    // First-ever start baselines: the cursor is persisted at the high-water mark.
    expect(cursorState(daemon.stateDir)).toBe(45);

    // Daemon down: issue #46 is created (route arrays are newest-first).
    routes.api["/repos/octo/repo/issues"] = issuesNewestFirst(46, 45);
    daemon.automation.stop();
    await daemon.automation.start(); // restart with the persisted cursor
    await flush();

    const workers = daemon.services.registry.listWorkers({ projectId: PROJECT });
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({ issueNumber: 46, status: "running" });
    expect(cursorState(daemon.stateDir)).toBe(46);

    // Another restart: the processed issue is not re-swept (cursor semantics).
    daemon.automation.stop();
    await daemon.automation.start();
    await flush();
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(1);
    expect(cursorState(daemon.stateDir)).toBe(46);
  });

  it("baselines a brand-new project's backlog and never mass-spawns it on restart", async () => {
    const routes = emptyRoutes();
    routes.api["/repos/octo/repo/issues"] = issuesNewestFirst(50, 49, 48, 3, 2, 1);
    const daemon = await registeredRoutesDaemon(routes);
    broadcasts(daemon);
    await daemon.automation.start();
    // First-ever start: no cursor yet ⇒ pure baseline, no retro-spawn.
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(0);
    expect(cursorState(daemon.stateDir)).toBe(50);

    // Restart with the cursor at the backlog's high-water mark: nothing spawns.
    daemon.automation.stop();
    await daemon.automation.start();
    await flush();
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(0);
    expect(cursorState(daemon.stateDir)).toBe(50);
  });

  it(`catches up a large backlog in bounded batches of ${CATCH_UP_BATCH_SIZE}, spread across polls`, async () => {
    vi.useFakeTimers(); // the spawn queue re-drains on a 5s poll timer
    try {
      const routes = emptyRoutes();
      routes.api["/repos/octo/repo/issues"] = issuesNewestFirst(40);
      const daemon = await registeredRoutesDaemon(routes, { autoAgentUsername: AUTO_USER, workerConcurrency: 16 });
      broadcasts(daemon);
      await daemon.automation.start();
      daemon.automation.stop();

      // 75 issues created while the daemon was down (41..115), newest first.
      routes.api["/repos/octo/repo/issues"] = issuesNewestFirst(...Array.from({ length: 75 }, (_, i) => 115 - i));
      await daemon.automation.start();
      await vi.advanceTimersByTimeAsync(1); // let the batch's spawns land

      // First batch at start: exactly CATCH_UP_BATCH_SIZE issues processed
      // (cursor 40 → 65); spawns honor the cap (16 running, 9 queued).
      const workerCount = () => daemon.services.registry.listWorkers({ projectId: PROJECT }).length;
      expect(workerCount()).toBe(16);
      expect(cursorState(daemon.stateDir)).toBe(40 + CATCH_UP_BATCH_SIZE);

      // Each poll-tick batch processes the next bounded slice — no burst.
      await daemon.automation.pollCatchUp(PROJECT);
      expect(cursorState(daemon.stateDir)).toBe(40 + 2 * CATCH_UP_BATCH_SIZE);
      await daemon.automation.pollCatchUp(PROJECT); // 91..115 is exactly one full batch
      expect(cursorState(daemon.stateDir)).toBe(115);

      // Fourth call: nothing above the cursor — the sweep is done.
      await daemon.automation.pollCatchUp(PROJECT);
      expect(cursorState(daemon.stateDir)).toBe(115);

      // Freeing the running workers lets the queue drain (5s poll), still capped.
      for (const worker of daemon.services.registry.listWorkers({ projectId: PROJECT })) {
        daemon.services.registry.updateWorkerStatus(worker.id, "done");
      }
      await vi.advanceTimersByTimeAsync(5_000);
      expect(workerCount()).toBe(32); // next 16 queued issues (57..72) spawned
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the live-path spawn matrix to catch-up issues: blocked issues are consumed, not spawned", async () => {
    const routes = {
      ...emptyRoutes(),
      // Issue #46 has an open native blocker — the catch-up must not spawn it.
      graphql: {
        ...emptyRoutes().graphql,
        "blockedBy(first:": {
          repository: {
            issue: {
              blockedBy: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ number: 40, state: "OPEN", repository: { nameWithOwner: "octo/repo" } }],
              },
            },
          },
        },
      },
    };
    routes.api["/repos/octo/repo/issues"] = issuesNewestFirst(45);
    const daemon = await registeredRoutesDaemon(routes);
    broadcasts(daemon);
    await daemon.automation.start();
    daemon.automation.stop();

    routes.api["/repos/octo/repo/issues"] = issuesNewestFirst(46, 45);
    await daemon.automation.start();
    await flush();

    // Blocked ⇒ no worker — identical to the live path — but the issue was
    // processed through the spawn matrix, so the cursor advances past it.
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(0);
    expect(cursorState(daemon.stateDir)).toBe(46);
  });

  it("dedupes catch-up issues against live watcher events (one worker per issue)", async () => {
    const routes = emptyRoutes();
    routes.api["/repos/octo/repo/issues"] = issuesNewestFirst(45);
    const daemon = await registeredRoutesDaemon(routes);
    broadcasts(daemon);
    await daemon.automation.start();
    daemon.automation.stop();

    routes.api["/repos/octo/repo/issues"] = issuesNewestFirst(46, 45);
    await daemon.automation.start();
    await flush();
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(1);

    // The live watcher also emits #46 (its snapshot was seeded before the
    // catch-up ran); the pipeline's dedupe keeps a single worker.
    daemon.automation.handleWatcherEvent(PROJECT, { type: "issue.created", at: NOW, issue: makeIssue(46) });
    await flush();
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(1);
  });

  it("honors the project's worker concurrency cap during catch-up", async () => {
    const routes = emptyRoutes();
    routes.api["/repos/octo/repo/issues"] = issuesNewestFirst(40);
    const daemon = await registeredRoutesDaemon(routes, { autoAgentUsername: AUTO_USER, workerConcurrency: 1 });
    broadcasts(daemon);
    await daemon.automation.start();
    daemon.automation.stop();

    routes.api["/repos/octo/repo/issues"] = issuesNewestFirst(43, 42, 41, 40);
    await daemon.automation.start();
    await flush();

    // Cap 1: the batch of three downtime-created issues yields one running
    // worker now; the rest queue FIFO through the scheduler (identical to
    // the live path) instead of bursting.
    const workers = daemon.services.registry.listWorkers({ projectId: PROJECT });
    expect(workers).toHaveLength(1);
    expect(workers[0]?.issueNumber).toBe(41);
  });

  it("applies the username rule to catch-up issues (author or assignee)", async () => {
    const routes = emptyRoutes();
    routes.api["/repos/octo/repo/issues"] = issuesNewestFirst(45);
    const daemon = await registeredRoutesDaemon(routes);
    broadcasts(daemon);
    await daemon.automation.start();
    daemon.automation.stop();

    // #46: authored by someone else, unassigned ⇒ no spawn.
    // #47: authored by someone else but assigned to the auto-agent ⇒ spawn.
    routes.api["/repos/octo/repo/issues"] = [
      restIssue(47, "someone-else", [AUTO_USER]),
      restIssue(46, "someone-else"),
      restIssue(45),
    ];
    await daemon.automation.start();
    await flush();

    const workers = daemon.services.registry.listWorkers({ projectId: PROJECT });
    expect(workers).toHaveLength(1);
    expect(workers[0]?.issueNumber).toBe(47);
    // Non-matching issues are consumed (cursor advances past them).
    expect(cursorState(daemon.stateDir)).toBe(47);
  });
});
