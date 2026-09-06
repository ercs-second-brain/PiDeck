import { afterEach, describe, expect, it, vi } from "vitest";
import { type PullRequest } from "@agentskiss/shared";

import { GhClient } from "./gh.js";
import type { IssueRecord } from "./issues.js";
import { DEFAULT_POLL_INTERVAL_MS, IssueWatcher, PollLoop, PullRequestWatcher, type GithubWatcherEvent } from "./watch.js";

const PROJECT = "proj";
const REPO = { owner: "o", repo: "r" };

function makeIssueRecord(number: number, overrides: Partial<{ author: string | null; assignees: string[]; title: string }> = {}): IssueRecord {
  return {
    issue: {
      projectId: PROJECT,
      number,
      title: overrides.title ?? `Issue ${number}`,
      state: "open",
      blockedBy: [],
      assignee: overrides.assignees?.[0] ?? null,
      url: `https://github.com/o/r/issues/${number}`,
      updatedAt: "2026-09-06T12:00:00Z",
    },
    author: overrides.author ?? "eric",
    assignees: overrides.assignees ?? [],
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
    headBranch: "feature",
    baseBranch: "main",
    author: "eric",
    url: `https://github.com/o/r/pull/${number}`,
    updatedAt: "2026-09-06T12:00:00Z",
    ...overrides,
  };
}

// REST-shaped payloads as the gh api endpoints would return them.
function restIssue(rec: IssueRecord): Record<string, unknown> {
  return {
    number: rec.issue.number,
    title: rec.issue.title,
    state: rec.issue.state,
    user: rec.author === null ? null : { login: rec.author },
    assignee: rec.assignees.length > 0 ? { login: rec.assignees[0] } : null,
    assignees: rec.assignees.map((login) => ({ login })),
    html_url: rec.issue.url,
    updated_at: rec.issue.updatedAt,
  };
}

function restPull(pr: PullRequest, sha = "abc123"): Record<string, unknown> {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state === "open" ? "open" : "closed",
    merged_at: pr.state === "merged" ? "2026-09-06T13:00:00Z" : null,
    user: { login: pr.author },
    head: { ref: pr.headBranch, sha },
    base: { ref: pr.baseBranch },
    html_url: pr.url,
    updated_at: pr.updatedAt,
  };
}

const CHECK_RUNS_NONE = { total_count: 0, check_runs: [] };
const CHECK_RUNS_FAILURE = { total_count: 1, check_runs: [{ status: "completed", conclusion: "failure" }] };

/**
 * GhClient driven by a sequence of poll snapshots. Snapshot fields:
 * - `issues`: REST issue list (used by IssueWatcher)
 * - `pulls`: REST PR list, `checkRuns`/`reviews`: enrichment responses
 *   (used by PullRequestWatcher; one PR per snapshot in these tests)
 */
function scriptedGh(snapshots: Array<{ issues?: Record<string, unknown>[]; pulls?: Record<string, unknown>[]; checkRuns?: object; reviews?: unknown[] }>): GhClient {
  let poll = 0;
  const at = (i: number) => snapshots[Math.min(Math.max(i, 0), snapshots.length - 1)] ?? {};
  return new GhClient(async (args) => {
    const path = args[1] ?? "";
    if (path.includes("/issues?state=open")) {
      const snap = at(poll);
      poll++;
      return { stdout: JSON.stringify(snap.issues ?? []), stderr: "" };
    }
    if (path.includes("/pulls?state=open")) {
      const snap = at(poll);
      poll++;
      return { stdout: JSON.stringify(snap.pulls ?? []), stderr: "" };
    }
    // Enrichment calls belong to the snapshot of the poll that issued them.
    const snap = at(poll - 1);
    if (path.includes("/check-runs")) return { stdout: JSON.stringify(snap.checkRuns ?? CHECK_RUNS_NONE), stderr: "" };
    if (path.includes("/commits/") && path.includes("/status")) return { stdout: JSON.stringify({ state: "success", total_count: 0 }), stderr: "" };
    if (path.includes("/reviews")) return { stdout: JSON.stringify(snap.reviews ?? []), stderr: "" };
    throw new Error(`unexpected args: ${JSON.stringify(args)}`);
  });
}

describe("IssueWatcher", () => {
  it("emits issue.created only for the watched user's issues", async () => {
    const gh = scriptedGh([
      { issues: [restIssue(makeIssueRecord(1)), restIssue(makeIssueRecord(2, { author: "someone-else" })), restIssue(makeIssueRecord(3, { author: "someone-else", assignees: ["eric"] }))] },
    ]);
    const watcher = new IssueWatcher({ gh, projectId: PROJECT, repo: REPO, username: "eric", emit: () => {} });
    const events = await watcher.pollOnce();
    expect(events.map((e) => e.type)).toEqual(["issue.created", "issue.created"]);
    expect(events.map((e) => (e.type === "issue.created" ? e.issue.number : null))).toEqual([1, 3]);
  });

  it("watches everything when username is null", async () => {
    const gh = scriptedGh([{ issues: [restIssue(makeIssueRecord(1, { author: "someone-else" }))] }]);
    const watcher = new IssueWatcher({ gh, projectId: PROJECT, repo: REPO, username: null, emit: () => {} });
    expect((await watcher.pollOnce()).map((e) => e.type)).toEqual(["issue.created"]);
  });

  it("emits issue.assigned when the watched user becomes an assignee", async () => {
    const gh = scriptedGh([
      { issues: [restIssue(makeIssueRecord(1))] },
      { issues: [restIssue(makeIssueRecord(1, { assignees: ["eric"] }))] },
    ]);
    const watcher = new IssueWatcher({ gh, projectId: PROJECT, repo: REPO, username: "eric", emit: () => {} });
    expect((await watcher.pollOnce()).map((e) => e.type)).toEqual(["issue.created"]);
    const events = await watcher.pollOnce();
    expect(events.map((e) => e.type)).toEqual(["issue.assigned"]);
    expect(events[0]?.type === "issue.assigned" && events[0]?.issue.assignee).toBe("eric");
  });

  it("does not re-emit created or assigned", async () => {
    const gh = scriptedGh([
      { issues: [restIssue(makeIssueRecord(1))] },
      { issues: [restIssue(makeIssueRecord(1, { assignees: ["eric"] }))] },
      { issues: [restIssue(makeIssueRecord(1, { assignees: ["eric"] }))] },
    ]);
    const watcher = new IssueWatcher({ gh, projectId: PROJECT, repo: REPO, username: "eric", emit: () => {} });
    expect((await watcher.pollOnce()).map((e) => e.type)).toEqual(["issue.created"]);
    expect((await watcher.pollOnce()).map((e) => e.type)).toEqual(["issue.assigned"]);
    expect(await watcher.pollOnce()).toEqual([]);
  });

  it("start() emits through the sink and stop() halts polling", async () => {
    vi.useFakeTimers();
    try {
      const gh = scriptedGh([{ issues: [restIssue(makeIssueRecord(1))] }]);
      const events: GithubWatcherEvent[] = [];
      const watcher = new IssueWatcher({ gh, projectId: PROJECT, repo: REPO, username: null, emit: (e) => events.push(e), pollIntervalMs: 10 });
      watcher.start();
      expect(watcher.isRunning).toBe(true);
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);
      expect(events.map((e) => e.type)).toEqual(["issue.created"]);
      watcher.stop();
      expect(watcher.isRunning).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PullRequestWatcher", () => {
  it("emits opened once, then updated only on changes (CI status flip)", async () => {
    const gh = scriptedGh([
      { pulls: [restPull(makePullRequest(7))], checkRuns: CHECK_RUNS_NONE },
      { pulls: [restPull(makePullRequest(7))], checkRuns: CHECK_RUNS_NONE },
      { pulls: [restPull(makePullRequest(7))], checkRuns: CHECK_RUNS_FAILURE },
    ]);
    const watcher = new PullRequestWatcher({ gh, projectId: PROJECT, repo: REPO, emit: () => {} });
    expect((await watcher.pollOnce()).map((e) => e.type)).toEqual(["pull_request.opened"]);
    expect(await watcher.pollOnce()).toEqual([]);
    const third = await watcher.pollOnce();
    expect(third.map((e) => e.type)).toEqual(["pull_request.updated"]);
    const updated = third[0]?.type === "pull_request.updated" ? third[0].pullRequest : null;
    expect(updated?.ciStatus).toBe("failure");
  });

  it("detects new PRs in later polls", async () => {
    const gh = scriptedGh([
      { pulls: [restPull(makePullRequest(7))], checkRuns: CHECK_RUNS_NONE },
      { pulls: [restPull(makePullRequest(7)), restPull(makePullRequest(8))], checkRuns: CHECK_RUNS_NONE },
    ]);
    const watcher = new PullRequestWatcher({ gh, projectId: PROJECT, repo: REPO, emit: () => {} });
    expect((await watcher.pollOnce()).map((e) => e.type)).toEqual(["pull_request.opened"]);
    const second = await watcher.pollOnce();
    expect(second.map((e) => e.type)).toEqual(["pull_request.opened"]);
    expect(second[0]?.type === "pull_request.opened" && second[0]?.pullRequest.number).toBe(8);
  });

  it("emits updated when the review state changes", async () => {
    const review = [{ user: { login: "a" }, state: "CHANGES_REQUESTED", submitted_at: "2026-09-06T12:00:00Z" }];
    const gh = scriptedGh([
      { pulls: [restPull(makePullRequest(7))], checkRuns: CHECK_RUNS_NONE, reviews: [] },
      { pulls: [restPull(makePullRequest(7))], checkRuns: CHECK_RUNS_NONE, reviews: review },
    ]);
    const watcher = new PullRequestWatcher({ gh, projectId: PROJECT, repo: REPO, emit: () => {} });
    expect((await watcher.pollOnce()).map((e) => e.type)).toEqual(["pull_request.opened"]);
    const second = await watcher.pollOnce();
    expect(second[0]?.type === "pull_request.updated" && second[0]?.pullRequest.reviewState).toBe("changes_requested");
  });

  it("start() wires emit and stop() works", async () => {
    vi.useFakeTimers();
    try {
      const gh = scriptedGh([{ pulls: [restPull(makePullRequest(7))], checkRuns: CHECK_RUNS_NONE }]);
      const events: GithubWatcherEvent[] = [];
      const watcher = new PullRequestWatcher({ gh, projectId: PROJECT, repo: REPO, emit: (e) => events.push(e), pollIntervalMs: 10 });
      watcher.start();
      await vi.advanceTimersByTimeAsync(50);
      watcher.stop();
      expect(events.map((e) => e.type)).toEqual(["pull_request.opened"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PollLoop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks repeatedly until stopped and surfaces errors via onError", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const errors: unknown[] = [];
    const loop = new PollLoop(
      async () => {
        ticks++;
        if (ticks === 1) throw new Error("boom");
      },
      10,
      (e) => errors.push(e),
    );
    loop.start();
    await vi.advanceTimersByTimeAsync(35);
    expect(ticks).toBeGreaterThanOrEqual(3);
    expect(errors).toHaveLength(1);
    loop.stop();
    const atStop = ticks;
    await vi.advanceTimersByTimeAsync(50);
    expect(ticks).toBe(atStop);
  });

  it("never runs two ticks concurrently", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    const loop = new PollLoop(
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
      },
      1,
      () => {},
    );
    loop.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(maxActive).toBe(1);
    loop.stop();
  });
});
