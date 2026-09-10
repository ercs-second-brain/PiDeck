/**
 * Wiring tests for the issue catch-up sweep (issue #50): the daemon-down
 * lifecycle — issues created while the daemon was off are swept on start,
 * the cursor persists across restarts, and catch-up spawns honor the same
 * spawn matrix, dedupe and concurrency caps as the live watcher path.
 *
 * Split from wiring.test.ts (issue #400, KISS audit F10); the live
 * watcher-event routing lives in wiring-routing.test.ts. Same fake
 * gh/git/tmux harness; no network or live GitHub is involved.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { testDaemon, type FakeGhRoutes, type TestDaemon } from "../api/testutil.js";
import type { GithubAutomation } from "./wiring.js";
import { CATCH_UP_BATCH_SIZE } from "./wiring.js";
import { broadcasts, emptyRoutes, flush, makeIssue, NO_TICK } from "./wiring-routing.test.js";

const REPO_URL = "https://github.com/octo/repo";
const PROJECT = "octo-repo";
const AUTO_USER = "octo-bot";
const NOW = "2026-09-06T12:00:00.000Z";


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

let active: TestDaemon | undefined;
afterEach(() => {
  active?.services.automation.stop();
  active = undefined;
});

// ---------------------------------------------------------------------------
// Cursor lifecycle: baseline, restart persistence, live-event dedupe
// ---------------------------------------------------------------------------

describe("GithubAutomation catch-up cursor lifecycle (#50)", () => {
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
});

// ---------------------------------------------------------------------------
// Bounded batching and the concurrency cap
// ---------------------------------------------------------------------------

describe("GithubAutomation catch-up batching & caps (#50)", () => {
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
    // worker now; the rest queue FIFO through the scheduler, not a burst.
    const workers = daemon.services.registry.listWorkers({ projectId: PROJECT });
    expect(workers).toHaveLength(1);
    expect(workers[0]?.issueNumber).toBe(41);
  });
});

// ---------------------------------------------------------------------------
// Spawn matrix and username eligibility, applied to downtime issues
// ---------------------------------------------------------------------------

describe("GithubAutomation catch-up spawn matrix & eligibility (#50)", () => {
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
                totalCount: 1,
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
