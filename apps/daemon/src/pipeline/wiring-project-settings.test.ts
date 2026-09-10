/**
 * Per-project pipeline-toggle precedence over the daemon-wide settings
 * (issue #322): the PR-pipeline unit resolves the effective toggles fresh
 * per decision — an explicit per-project boolean wins, `null` inherits.
 * Split from wiring.test.ts (kiss max-lines budget); emptyRoutes/
 * registeredDaemon are imported from it (issue #322).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TestDaemon } from "../api/testutil.js";
import { makePullRequest as sharedMakePullRequest, restPull } from "../testing/fixtures.js";
import { emptyRoutes, registeredDaemon } from "./wiring-routing.test.js";

const PROJECT = "octo-repo";
const NOW = "2026-09-06T12:00:00.000Z";

function makePullRequest(number: number, overrides: Partial<Parameters<typeof sharedMakePullRequest>[1]> = {}) {
  return sharedMakePullRequest(number, { projectId: PROJECT, ...overrides });
}

let active: TestDaemon | undefined;
afterEach(() => {
  active?.services.automation.stop();
  active = undefined;
});

describe("per-project pipeline toggles (issue #322)", () => {
  it("per-project pipeline toggles override the daemon-wide settings (issue #322)", async () => {
    const daemon = await registeredDaemon({
      ...emptyRoutes(),
      api: {
        ...emptyRoutes().api,
        "/repos/octo/repo/pulls": [restPull(7)],
        "/repos/octo/repo/pulls/7": restPull(7),
        "/repos/octo/repo/commits/sha-1/check-runs": {
          total_count: 1,
          check_runs: [{ name: "build", status: "completed", conclusion: "failure" }],
        },
        "/repos/octo/repo/pulls/7/reviews": [],
        "/repos/octo/repo/pulls/7/comments": [],
      },
    });
    active = daemon;
    await daemon.services.automation.start();

    const { worker } = await daemon.services.sessions.spawnWorker(PROJECT, { issueNumber: 46 });
    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "pull_request.opened",
      at: NOW,
      pullRequest: makePullRequest(7, { title: "Resolve #46: fix the loop", headBranch: "issue-46-fix" }),
    });

    // Daemon-wide autoFixCi is ON by default, but the project turns it off:
    // the loop must skip the fix prompt.
    await daemon.services.projects.update(PROJECT, { settings: { autoFixCi: false } });
    const sendKeys = vi.spyOn(daemon.services.sessions, "sendKeys");
    await daemon.automation.pollPrPipeline(PROJECT);
    expect(sendKeys).not.toHaveBeenCalled();

    // Re-enabling per-project (null = inherit daemon-wide ON) → prompt fires.
    await daemon.services.projects.update(PROJECT, { settings: { autoFixCi: null } });
    await daemon.automation.pollPrPipeline(PROJECT);
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(String(sendKeys.mock.calls[0]?.[1])).toContain("CI is failing on your PR #7");
    expect(daemon.services.registry.getWorker(worker.id)!.status).toBe("fixing_ci");
  });
});
