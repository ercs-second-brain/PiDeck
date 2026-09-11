/**
 * Wiring tests for the GitHub automation loop (issue #46): watcher event
 * routing through `automation.handleWatcherEvent` — the same router the
 * real watchers emit into.
 *
 * - a watcher event for a fresh unblocked issue spawns a worker and emits
 *   kanban events on the WS hub (`worker.spawned`, `kanban.card.moved`);
 * - a PR watcher event reaches the PR loop (worker association via the
 *   session registry + tracker, red-CI fix prompt through tmux);
 * - `stop()` (the SIGTERM path) halts all polling and event routing first.
 *
 * Split from wiring.test.ts (issue #400, KISS audit F10): the issue
 * catch-up lifecycle lives in wiring-lifecycle.test.ts. Uses the same fake
 * gh/git/tmux harness as the API-layer tests; watcher events are
 * dispatched synthetically, so no network or live GitHub is involved.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Issue, PullRequest, WsServerEvent } from "@pideck/shared";

import { testDaemon, type FakeGhRoutes, type TestDaemon } from "../api/testutil.js";
import { makeIssue as sharedMakeIssue, makePullRequest as sharedMakePullRequest, restPull as sharedRestPull } from "../testing/fixtures.js";
import type { GithubAutomation } from "./wiring.js";
import { watcherOptionsFromEnv } from "./wiring.js";

const REPO_URL = "https://github.com/octo/repo";
const PROJECT = "octo-repo";
const AUTO_USER = "octo-bot";
const NOW = "2026-09-06T12:00:00.000Z";

// Poll interval so large that the running loops never tick again within a
// test: every GitHub interaction below is driven explicitly.
export const NO_TICK = 3_600_000;

export function emptyRoutes(): FakeGhRoutes & { api: Record<string, unknown>; graphql: Record<string, unknown> } {
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
          issue: { blockedBy: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
        },
      },
    },
  };
}

// Thin bindings of the shared fixtures (apps/daemon/src/testing/fixtures.ts)
// to this file's constants — octo/repo under project "octo-repo" at NOW.
export function makeIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  return sharedMakeIssue(number, {
    projectId: PROJECT,
    url: `https://github.com/octo/repo/issues/${number}`,
    updatedAt: NOW,
    // Inline detail: the spawn pipeline never calls the blocker resolver.
    blockers: [],
    ...overrides,
  });
}

function makePullRequest(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return sharedMakePullRequest(number, {
    projectId: PROJECT,
    author: AUTO_USER,
    headBranch: `feature-${number}`,
    url: `https://github.com/octo/repo/pull/${number}`,
    updatedAt: NOW,
    ...overrides,
  });
}

/** REST pull payload (mapRestPull shape) for the PR pipeline's polls. */
function restPull(number: number, sha: string): Record<string, unknown> {
  return sharedRestPull(number, { sha, author: AUTO_USER, headBranch: `feature-${number}`, updatedAt: NOW });
}

export async function registeredDaemon(ghRoutes: FakeGhRoutes = emptyRoutes()): Promise<TestDaemon & { automation: GithubAutomation }> {
  const daemon = testDaemon(ghRoutes, { watcherPollIntervalMs: NO_TICK });
  await daemon.services.projects.register({ mode: "clone", repoUrl: REPO_URL });
  return { ...daemon, automation: daemon.services.automation };
}

export function broadcasts(daemon: TestDaemon): WsServerEvent[] {
  const events: WsServerEvent[] = [];
  vi.spyOn(daemon.services.hub, "broadcast").mockImplementation((event) => {
    events.push(event);
  });
  return events;
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

let active: TestDaemon | undefined;
afterEach(() => {
  active?.services.automation.stop();
  active = undefined;
});

// ---------------------------------------------------------------------------
// Issue → worker spawn (watcher event routing, #416)
// ---------------------------------------------------------------------------

describe("GithubAutomation issue wiring (#46)", () => {
  it("spawns a worker for a fresh unblocked issue event and emits kanban events on the hub", async () => {
    const daemon = await registeredDaemon();
    active = daemon;
    const events = broadcasts(daemon);
    await daemon.services.automation.start();

    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "issue.assigned",
      at: NOW,
      issue: makeIssue(46, { assignee: AUTO_USER }),
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

    // Dedupe: a re-assignment (redelivered event) does not spawn a second
    // worker (issue #416: assignment spawns once).
    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "issue.assigned",
      at: NOW,
      issue: makeIssue(46, { assignee: AUTO_USER }),
    });
    await flush();
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(1);
  });

  it("does not spawn on issue.created — assignment is the only spawn trigger (#416)", async () => {
    const daemon = await registeredDaemon();
    active = daemon;
    broadcasts(daemon);
    await daemon.services.automation.start();

    daemon.services.automation.handleWatcherEvent(PROJECT, { type: "issue.created", at: NOW, issue: makeIssue(1) });
    await flush();
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(0);
  });

  it("retracts on unassign/close: queued spawns are cancelled and running workers archived (#416)", async () => {
    const daemon = await registeredDaemon();
    active = daemon;
    broadcasts(daemon);
    await daemon.services.automation.start();

    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "issue.assigned",
      at: NOW,
      issue: makeIssue(9, { assignee: AUTO_USER }),
    });
    await flush();
    const worker = daemon.services.registry.listWorkers({ projectId: PROJECT })[0];
    expect(worker).toMatchObject({ issueNumber: 9, status: "running" });

    // Unassign: the worker is archived, not left as a zombie.
    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "issue.unassigned",
      at: NOW,
      issue: makeIssue(9),
    });
    await flush();
    expect(daemon.services.registry.getWorker(worker?.id ?? "")?.status).toBe("archived");

    // Re-assign spawns a fresh worker (the retract cleared the dedupe mark).
    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "issue.assigned",
      at: NOW,
      issue: makeIssue(9, { assignee: AUTO_USER }),
    });
    await flush();
    const running = daemon.services.registry.listWorkers({ projectId: PROJECT, status: "running" });
    expect(running).toHaveLength(1);
    expect(running[0]?.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// Watcher state: stop ordering, backlog baseline, resync, kill switch
// ---------------------------------------------------------------------------

describe("GithubAutomation watcher state (#46)", () => {
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
    daemon.services.automation.handleWatcherEvent(PROJECT, { type: "issue.assigned", at: NOW, issue: makeIssue(46, { assignee: AUTO_USER }) });
    await flush();
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(0);
  });

  it("start() baselines the issue watcher so the existing backlog does not mass-spawn", async () => {
    // A pre-existing open issue would be emitted as `issue.created` by
    // the watcher's first poll; the baseline sweep at start() must discard
    // it (and it spawns nothing anyway — #416: assignment is the trigger).
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

    await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/octo/two" });
    expect(daemon.automation.watchedProjectIds.sort()).toEqual([PROJECT, "octo-two"]);
  });

  it("is inert when disabled (PD_WATCHER_ENABLED=0 semantics)", async () => {
    const daemon = testDaemon(emptyRoutes(), { watcherEnabled: false, watcherPollIntervalMs: NO_TICK });
    active = daemon;
    await daemon.services.projects.register({ mode: "clone", repoUrl: REPO_URL });
    broadcasts(daemon);
    await daemon.services.automation.start();

    expect(daemon.services.automation.isRunning).toBe(false);
    expect(daemon.services.automation.watchedProjectIds).toEqual([]);
    daemon.services.automation.handleWatcherEvent(PROJECT, { type: "issue.assigned", at: NOW, issue: makeIssue(46, { assignee: AUTO_USER }) });
    await flush();
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PR → lifecycle loop
// ---------------------------------------------------------------------------

describe("GithubAutomation PR wiring (#46)", () => {
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
          check_runs: [{ name: "build", status: "completed", conclusion: "failure" }],
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
    expect(worker.prNumbers).toEqual([]);

    // PR watcher event: the PR's title references the worker's issue → the
    // wiring records the association on the session registry (setWorkerPr)
    // and the PR loop tracks it, emitting the initial card.
    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "pull_request.opened",
      at: NOW,
      pullRequest: makePullRequest(7, { title: "Resolve #46: fix the loop", headBranch: "issue-46-fix" }),
    });

    expect(daemon.services.registry.getWorker(worker.id)!.prNumbers).toContain(7);
    expect(events.find((e) => e.type === "kanban.card.moved" && e.cardId === `pr:${PROJECT}:7`))
      .toMatchObject({ card: { kind: "pull_request", number: 7, column: "in_progress", workerId: worker.id } });
    // The loop drives the red PR: a bounded CI-fix prompt goes to the
    // worker's tmux session, and the status change reaches the hub.
    const sendKeys = vi.spyOn(daemon.services.sessions, "sendKeys");
    await daemon.automation.pollPrPipeline(PROJECT);

    expect(sendKeys).toHaveBeenCalledTimes(1);
    const [sessionId, prompt] = sendKeys.mock.calls[0] ?? [];
    expect(sessionId).toBe(worker.sessionId);
    // #322: the prompt names the failing check from the check-runs route.
    expect(String(prompt)).toMatch(/CI is failing on your PR #7.*Failing checks: build.*attempt 1 of /);
    expect(events.some((e) => e.type === "worker.status.changed" && e.status === "fixing_ci")).toBe(true);
  });

  it("re-associates a tracked PR to the worker its pideck/ head branch names (issue #466)", async () => {
    const daemon = await registeredDaemon({
      ...emptyRoutes(),
      api: {
        ...emptyRoutes().api,
        // PR pipeline discovery + per-PR state (red CI on sha-1).
        "/repos/octo/repo/pulls": [restPull(7, "sha-1")],
        "/repos/octo/repo/pulls/7": restPull(7, "sha-1"),
        "/repos/octo/repo/commits/sha-1/check-runs": {
          total_count: 1,
          check_runs: [{ name: "build", status: "completed", conclusion: "failure" }],
        },
        "/repos/octo/repo/pulls/7/reviews": [],
        "/repos/octo/repo/pulls/7/comments": [],
      },
    });
    active = daemon;
    broadcasts(daemon);
    await daemon.services.automation.start();

    // Two parallel workers on issue #46: a PR whose title references the
    // issue is heuristic evidence — the first scanned worker claimed it
    // (the mis-attribution pattern from the AO #452 lesson).
    const { worker: claimed } = await daemon.services.sessions.spawnWorker(PROJECT, { issueNumber: 46 });
    const { worker: author } = await daemon.services.sessions.spawnWorker(PROJECT, { issueNumber: 46 });

    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "pull_request.opened",
      at: NOW,
      pullRequest: makePullRequest(7, { title: "Resolve #46: fix the loop", headBranch: "issue-46-fix" }),
    });
    expect(daemon.services.registry.getWorker(claimed.id)!.prNumbers).toContain(7);

    // Re-watch: the PR's real head branch names the author's worker — the
    // namespace is the deterministic key, so ownership self-corrects.
    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "pull_request.updated",
      at: NOW,
      pullRequest: makePullRequest(7, { title: "Resolve #46: fix the loop", headBranch: `pideck/${author.id}` }),
    });
    expect(daemon.services.registry.getWorker(author.id)!.prNumbers).toContain(7);
    expect(daemon.services.registry.getWorker(claimed.id)!.prNumbers).not.toContain(7);

    // The red-PR CI-fix prompt lands on the namespaced worker's pane now.
    const sendKeys = vi.spyOn(daemon.services.sessions, "sendKeys");
    await daemon.automation.pollPrPipeline(PROJECT);
    const [sessionId] = sendKeys.mock.calls[0] ?? [];
    expect(sessionId).toBe(author.sessionId);
  });
});

// ---------------------------------------------------------------------------
// Knobs
// ---------------------------------------------------------------------------

describe("GithubAutomation watcher knobs", () => {
  it("resolves the watcher knobs from env with sane defaults", () => {
    expect(watcherOptionsFromEnv({})).toEqual({ enabled: true, pollIntervalMs: 30_000 });
    expect(watcherOptionsFromEnv({ PD_WATCHER_ENABLED: "0" })).toEqual({ enabled: false, pollIntervalMs: 30_000 });
    expect(watcherOptionsFromEnv({ PD_WATCHER_ENABLED: "false" })).toEqual({ enabled: false, pollIntervalMs: 30_000 });
    expect(watcherOptionsFromEnv({ PD_WATCHER_ENABLED: "1" })).toEqual({ enabled: true, pollIntervalMs: 30_000 });
    expect(watcherOptionsFromEnv({ PD_WATCHER_POLL_INTERVAL_MS: "120000" })).toEqual({
      enabled: true,
      pollIntervalMs: 120_000,
    });
    // Invalid values fall back to the default instead of hammering the API.
    expect(watcherOptionsFromEnv({ PD_WATCHER_POLL_INTERVAL_MS: "-5" })).toEqual({
      enabled: true,
      pollIntervalMs: 30_000,
    });
    // Explicit options win over env.
    expect(
      watcherOptionsFromEnv({ PD_WATCHER_POLL_INTERVAL_MS: "120000" }, { enabled: false, pollIntervalMs: 1000 }),
    ).toEqual({ enabled: false, pollIntervalMs: 1000 });
  });
});
