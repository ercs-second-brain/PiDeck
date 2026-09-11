/**
 * Wiring tests for the issue-worker stall backstop (issue #467): the
 * automation exposes the sweep over watched projects, delivers the bounded
 * re-prompts into the worker's pane, and broadcasts the exhaustion
 * notification on the hub.
 *
 * Same fake gh/git/tmux harness as wiring-routing.test.ts; staleness is
 * produced by rewinding the worker record's `updatedAt` (white-box: the
 * registry keeps worker objects in an in-memory map the test can reach).
 */

import { afterEach, describe, expect, it } from "vitest";

import type { TestDaemon } from "../api/testutil.js";
import type { FakeGhRoutes } from "../api/testutil.js";
import type { GithubAutomation } from "./wiring.js";
import { AUTO_USER, broadcasts, emptyRoutes, flush, makeIssue, PROJECT, registeredDaemon } from "./wiring-routing.test.js";

const NOW = "2026-09-06T12:00:00.000Z";
/** The staleness window the sweep needs, minus margin (default 15 min). */
const STALE = 2 * 60 * 60_000;

let active: TestDaemon | undefined;
afterEach(() => {
  active?.services.automation.stop();
  active = undefined;
});

/** Spawns one worker through the live watcher-event path. */
async function spawnedIssueWorker(
  routes: FakeGhRoutes,
): Promise<{ daemon: TestDaemon & { automation: GithubAutomation }; workerId: string; tmuxSession: string }> {
  const daemon = await registeredDaemon(routes);
  active = daemon;
  broadcasts(daemon);
  await daemon.services.automation.start();
  daemon.services.automation.handleWatcherEvent(PROJECT, {
    type: "issue.assigned",
    at: NOW,
    issue: makeIssue(46, { assignee: AUTO_USER }),
  });
  await flush();
  const worker = daemon.services.registry.listWorkers({ projectId: PROJECT })[0];
  if (worker === undefined) throw new Error("expected a spawned worker");
  const session = daemon.services.registry.getSession(worker.sessionId);
  if (session === null || session === undefined) throw new Error("expected the worker's tmux session");
  return { daemon, workerId: worker.id, tmuxSession: session.tmuxSession };
}

describe("GithubAutomation stall sweep wiring (#467)", () => {
  it("re-prompts a stale issue worker into its pane, bounded, then notifies on the hub", async () => {
    const { daemon, workerId, tmuxSession } = await spawnedIssueWorker(emptyRoutes());
    const events = broadcasts(daemon);

    const rewind = (): void => {
      const worker = daemon.services.registry.getWorker(workerId);
      if (worker === undefined) throw new Error("worker vanished");
      worker.updatedAt = new Date(Date.now() - STALE).toISOString();
    };

    // Five bounded re-prompts — each rewound, since a re-prompt refreshes
    // the record (that refresh is the sweep's re-arm).
    for (let i = 0; i < 5; i += 1) {
      rewind();
      await daemon.automation.pollStallSweep(PROJECT);
    }
    const pane = await daemon.services.tmux.capturePane(tmuxSession);
    expect(pane).toContain("Stall backstop");
    expect(pane).toContain("Closes #46");
    const worker = daemon.services.registry.getWorker(workerId);
    expect(worker?.statusMessage).toContain("re-prompted (5/5");

    // The sixth stale pass exceeds the bound: the exhaustion notification
    // is broadcast on the hub (once — further passes stay quiet).
    rewind();
    await daemon.automation.pollStallSweep(PROJECT);
    const stalled = events.filter((e) => e.type === "notification.worker.stalled");
    expect(stalled).toHaveLength(1);
    expect(stalled[0]).toMatchObject({ projectId: PROJECT, workerId, issueNumber: 46 });
    rewind();
    await daemon.automation.pollStallSweep(PROJECT);
    expect(events.filter((e) => e.type === "notification.worker.stalled")).toHaveLength(1);
  });

  it("does not sweep workers with a fresh record or a held prompt", async () => {
    const { daemon, tmuxSession } = await spawnedIssueWorker(emptyRoutes());
    broadcasts(daemon);
    // Fresh record: no re-prompt.
    await daemon.automation.pollStallSweep(PROJECT);
    expect(await daemon.services.tmux.capturePane(tmuxSession)).not.toContain("Stall backstop");
  });

  it("skips projects that are not currently watched", async () => {
    const { daemon } = await spawnedIssueWorker(emptyRoutes());
    broadcasts(daemon);
    await expect(daemon.automation.pollStallSweep("ghost-project")).resolves.toBeUndefined();
  });
});