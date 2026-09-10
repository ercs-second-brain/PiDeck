/**
 * Wiring tests for the deterministic PR lifecycle's orchestrator leg (issue
 * #408, flow step 8): when the PR loop observes a merge, the automation
 * re-evaluates the project's recorded blocked tickets and spawns workers for
 * the ones the merge unblocked — through the same spawn matrix as the
 * watcher path (dedupe + concurrency caps), so no conflict with running
 * workers is possible. Same fake gh/git/tmux harness as the other wiring
 * tests; no network.
 */

import { afterEach, describe, expect, it } from "vitest";

import { testDaemon, type FakeGhRoutes, type TestDaemon } from "../api/testutil.js";
import { broadcasts, emptyRoutes, flush, registeredDaemon } from "./wiring-routing.test.js";
import { restPull as sharedRestPull } from "../testing/fixtures.js";

const PROJECT = "octo-repo";
const NOW = "2026-09-06T12:00:00.000Z";

let active: TestDaemon | undefined;
afterEach(() => {
  active?.services.automation.stop();
  active = undefined;
});


function blockerPage(state: "OPEN" | "CLOSED"): Record<string, unknown> {
  return {
    repository: {
      issue: { blockedBy: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ number: 2, state, repository: { nameWithOwner: "octo/repo" } }] } },
    },
  };
}

describe("GithubAutomation merge → unblock sweep (issue #408)", () => {
  it("a merged PR spawns workers for the blocked tickets its Closes-references unblocked", async () => {
    const routes: FakeGhRoutes & { api: Record<string, unknown>; graphql: Record<string, unknown> } = {
      ...emptyRoutes(),
      graphql: {
        ...emptyRoutes().graphql,
        // The spawn matrix's blockedBy resolution: issue #50 is blocked by #2.
        "blockedBy(first:": blockerPage("OPEN"),
      },
    };
    const daemon = await registeredDaemon(routes);
    active = daemon;
    const events = broadcasts(daemon);
    await daemon.services.automation.start();

    // Issue #50 arrives blocked → suppressed and recorded for the sweep.
    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "issue.created",
      at: NOW,
      issue: {
        projectId: PROJECT,
        number: 50,
        title: "Follow-up work",
        state: "open",
        blockedBy: [],
        assignee: null,
        url: "https://github.com/octo/repo/issues/50",
        updatedAt: NOW,
      },
    });
    await daemon.automation.pollCatchUp(PROJECT);
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT }).filter((w) => w.issueNumber === 50)).toHaveLength(0);

    // A worker opens PR #7 and reports it.
    const { worker } = await daemon.services.sessions.spawnWorker(PROJECT, { issueNumber: 46 });
    daemon.services.registry.setWorkerPr(worker.id, 7);

    // PR #7 merges — GitHub closed its "Closes #2" issue at merge time, so
    // the sweep now resolves #50 as unblocked.
    routes.graphql["blockedBy(first:"] = blockerPage("CLOSED");
    routes.api["/repos/octo/repo/pulls"] = [mergedPull()];
    routes.api["/repos/octo/repo/pulls/7"] = mergedPull();
    routes.api["/repos/octo/repo/commits/sha-1/check-runs"] = {
      total_count: 1,
      check_runs: [{ name: "build", status: "completed", conclusion: "success" }],
    };
    routes.api["/repos/octo/repo/pulls/7/reviews"] = [];
    routes.api["/repos/octo/repo/pulls/7/comments"] = [];

    await daemon.automation.pollPrPipeline(PROJECT);
    await flush();

    expect(events.some((e) => e.type === "notification.pr.merged" && e.prNumber === 7)).toBe(true);
    expect(events.some((e) => e.type === "notification.pr.merged" && e.prNumber === 7)).toBe(true);
    const unblocked = daemon.services.registry.listWorkers({ projectId: PROJECT }).filter((w) => w.issueNumber === 50);
    expect(unblocked).toHaveLength(1);
  });
});

/** A merged PR #7 payload (the PR loop observes the merge via `merged_at`). */
function mergedPull(): Record<string, unknown> {
  // GitHub REST shape for a merged PR: state "closed" + merged_at set.
  return sharedRestPull(7, { sha: "sha-1", author: "octo-bot", headBranch: "issue-46-fix", updatedAt: NOW, closed: true, merged: true });
}

void testDaemon;
