/**
 * Wiring-level regression tests for issue-assigned auto-spawn prompts
 * (issue #266): a worker spawned by the issue pipeline must receive the
 * issue context as its initial prompt — typed into its pane (pi-ready
 * path) or held on the prompt gate (issue #56 parity, unauthenticated) —
 * and never boot into an empty pane and idle.
 *
 * Uses the same fake gh/git/tmux harness as the API-layer tests; watcher
 * events are dispatched synthetically through `automation.handleWatcherEvent`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { testDaemon, type FakeGhRoutes, type TestDaemon } from "../api/testutil.js";
import type { Issue } from "@pideck/shared";
import { makeIssue as sharedMakeIssue } from "../testing/fixtures.js";

const REPO_URL = "https://github.com/octo/repo";
const PROJECT = "octo-repo";
const AUTO_USER = "octo-bot";
const NOW = "2026-09-06T12:00:00.000Z";

/** Poll interval so large that the running loops never tick within a test. */
const NO_TICK = 3_600_000;

function emptyRoutes(): FakeGhRoutes {
  return {
    api: {
      "/repos/octo/repo/issues": [],
      "/repos/octo/repo/pulls": [],
    },
    graphql: {
      // listOpenPullRequestsBatched (PR watcher baseline): empty page.
      "pullRequests(first:": {
        repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
      },
    },
  };
}

function makeIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  return sharedMakeIssue(number, {
    projectId: PROJECT,
    url: `https://github.com/octo/repo/issues/${number}`,
    updatedAt: NOW,
    blockers: [], // inline detail: the spawn matrix never resolves blockers
    ...overrides,
  });
}

async function registeredDaemon(options: { piReady?: boolean } = {}): Promise<TestDaemon> {
  const daemon = testDaemon(emptyRoutes(), { watcherPollIntervalMs: NO_TICK, ...options });
  await daemon.services.projects.register({ mode: "clone", repoUrl: REPO_URL });
  await daemon.services.automation.start();
  return daemon;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Polls (real timers) until `condition` holds — bounded, for background deliveries. */
async function waitForCondition(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("waitForCondition: timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let active: TestDaemon | undefined;
afterEach(() => {
  active?.services.automation.stop();
  active = undefined;
});

describe("issue-assigned auto-spawn delivers the issue prompt (issue #266)", () => {
  it("types the issue context into the worker pane and records it on the worker", async () => {
    const daemon = await registeredDaemon();
    active = daemon;
    // Issue #318: call-through spy — the confirm step reads the pane for
    // submit evidence, so the typed text must actually land in the fake pane.
    const sendKeys = vi.spyOn(daemon.services.sessions, "sendKeys");

    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "issue.assigned",
      at: NOW,
      issue: makeIssue(266, { assignee: AUTO_USER, title: "Issue-assigned worker idles" }),
    });
    await flush();

    // The spawned worker carries the issue context as its initial prompt,
    // both on the worker record and typed into the pane with Enter.
    const workers = daemon.services.registry.listWorkers({ projectId: PROJECT });
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({ issueNumber: 266, status: "running" });
    expect(workers[0]?.prompt).toContain("#266");
    expect(workers[0]?.prompt).toContain("Issue-assigned worker idles");
    expect(sendKeys).toHaveBeenCalledWith(workers[0]?.sessionId, expect.stringContaining("#266"), { enter: true });
    // Delivery runs in the background after the spawn resolves; settle it,
    // then re-read for the truthful post-delivery status message. Issue
    // #318: delivery ends with a bounded submit-confirmation poll (real
    // timers), so wait for the flip instead of assuming fixed flush counts.
    await waitForCondition(() =>
      daemon.services.registry.getWorker(workers[0]?.id ?? "")?.statusMessage === "agent running; initial prompt delivered",
    );
  });

  it("holds the issue prompt on the gate when pi auth is not ready (issue #56 parity)", async () => {
    const daemon = await registeredDaemon({ piReady: false });
    active = daemon;
    const sendKeys = vi.spyOn(daemon.services.sessions, "sendKeys").mockResolvedValue(undefined);

    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "issue.assigned",
      at: NOW,
      issue: makeIssue(266, { assignee: AUTO_USER }),
    });
    await flush();

    // Unauthenticated spawn: the prompt is never typed into a dead pane —
    // the worker holds at `spawning` and the prompt waits on the gate.
    const workers = daemon.services.registry.listWorkers({ projectId: PROJECT });
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({ issueNumber: 266, status: "spawning" });
    expect(workers[0]?.prompt).toContain("#266");
    expect(daemon.services.promptGate.size).toBe(1);
    expect(sendKeys).not.toHaveBeenCalled();
  });
});
