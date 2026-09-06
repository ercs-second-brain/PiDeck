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

/**
 * GhClient driven by a sequence of poll snapshots (REST issue lists, used by
 * IssueWatcher tests).
 */
function scriptedGh(snapshots: Array<{ issues?: Record<string, unknown>[] }>): GhClient {
  let poll = 0;
  const at = (i: number) => snapshots[Math.min(Math.max(i, 0), snapshots.length - 1)] ?? {};
  return new GhClient(async (args) => {
    const path = args[1] ?? "";
    if (path.includes("/issues?state=open")) {
      const snap = at(poll);
      poll++;
      return { stdout: JSON.stringify(snap.issues ?? []), stderr: "" };
    }
    throw new Error(`unexpected args: ${JSON.stringify(args)}`);
  });
}

/**
 * GraphQL pullRequest node in the batched-listing shape (fixture style from
 * pulls.test.ts), derived from a PullRequest so event assertions can compare
 * against the shared contract.
 */
function gqlPull(pr: PullRequest, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const rollup =
    pr.ciStatus === "success"
      ? { state: "SUCCESS" }
      : pr.ciStatus === "failure"
        ? { state: "FAILURE" }
        : pr.ciStatus === "pending"
          ? { state: "PENDING" }
          : null;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    updatedAt: pr.updatedAt,
    author: { login: pr.author },
    headRefName: pr.headBranch,
    baseRefName: pr.baseBranch,
    headRefOid: "abc123",
    reviewDecision: pr.reviewState === "approved" ? "APPROVED" : pr.reviewState === "changes_requested" ? "CHANGES_REQUESTED" : null,
    commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] },
    ...overrides,
  };
}

/**
 * GhClient for PullRequestWatcher tests: serves each poll's open-PR nodes via
 * the single batched GraphQL call and fails loudly on any REST route —
 * proving no per-PR enrichment calls remain in the poll loop. Returns the
 * argv of every call for O(1)-per-poll assertions.
 */
function batchedGh(snapshots: Array<Record<string, unknown>[]>): { gh: GhClient; calls: string[][] } {
  let poll = 0;
  const calls: string[][] = [];
  const at = (i: number) => snapshots[Math.min(Math.max(i, 0), snapshots.length - 1)] ?? [];
  const gh = new GhClient(async (args) => {
    calls.push(args);
    if (args[1] === "graphql") {
      return { stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: at(poll++) } } } }), stderr: "" };
    }
    throw new Error(`unexpected non-graphql call: ${JSON.stringify(args)}`);
  });
  return { gh, calls };
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
  it("emits opened once, then updated only on changes (CI rollup flip)", async () => {
    const { gh, calls } = batchedGh([
      [gqlPull(makePullRequest(7))],
      [gqlPull(makePullRequest(7))],
      [gqlPull(makePullRequest(7), { commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } })],
    ]);
    const watcher = new PullRequestWatcher({ gh, projectId: PROJECT, repo: REPO, emit: () => {} });
    expect((await watcher.pollOnce()).map((e) => e.type)).toEqual(["pull_request.opened"]);
    expect(await watcher.pollOnce()).toEqual([]);
    const third = await watcher.pollOnce();
    expect(third.map((e) => e.type)).toEqual(["pull_request.updated"]);
    const updated = third[0]?.type === "pull_request.updated" ? third[0].pullRequest : null;
    expect(updated?.ciStatus).toBe("failure");
    // O(1) per poll: exactly one batched GraphQL call, no REST enrichment.
    expect(calls).toHaveLength(3);
    expect(calls.every((args) => args[1] === "graphql")).toBe(true);
  });

  it("detects new PRs and emits the unchanged PullRequest contract", async () => {
    const { gh, calls } = batchedGh([
      [gqlPull(makePullRequest(7))],
      [gqlPull(makePullRequest(7)), gqlPull(makePullRequest(8))],
    ]);
    const watcher = new PullRequestWatcher({ gh, projectId: PROJECT, repo: REPO, emit: () => {} });
    expect((await watcher.pollOnce()).map((e) => e.type)).toEqual(["pull_request.opened"]);
    const second = await watcher.pollOnce();
    expect(second.map((e) => e.type)).toEqual(["pull_request.opened"]);
    expect(second[0]?.type === "pull_request.opened" && second[0]?.pullRequest).toEqual(makePullRequest(8));
    expect(calls).toHaveLength(2);
  });

  it("emits updated when the review decision changes", async () => {
    const { gh } = batchedGh([
      [gqlPull(makePullRequest(7))],
      [gqlPull(makePullRequest(7), { reviewDecision: "CHANGES_REQUESTED" })],
    ]);
    const watcher = new PullRequestWatcher({ gh, projectId: PROJECT, repo: REPO, emit: () => {} });
    expect((await watcher.pollOnce()).map((e) => e.type)).toEqual(["pull_request.opened"]);
    const second = await watcher.pollOnce();
    expect(second[0]?.type === "pull_request.updated" && second[0]?.pullRequest.reviewState).toBe("changes_requested");
  });

  it("emits updated when the title changes", async () => {
    const { gh } = batchedGh([
      [gqlPull(makePullRequest(7))],
      [gqlPull(makePullRequest(7), { title: "PR 7 (edited)" })],
    ]);
    const watcher = new PullRequestWatcher({ gh, projectId: PROJECT, repo: REPO, emit: () => {} });
    expect((await watcher.pollOnce()).map((e) => e.type)).toEqual(["pull_request.opened"]);
    const second = await watcher.pollOnce();
    expect(second[0]?.type === "pull_request.updated" && second[0]?.pullRequest.title).toBe("PR 7 (edited)");
  });

  it("makes one API call per poll regardless of open-PR count", async () => {
    const snapshot = [1, 2, 3, 4, 5].map((n) => gqlPull(makePullRequest(n)));
    const { gh, calls } = batchedGh([snapshot, snapshot]);
    const watcher = new PullRequestWatcher({ gh, projectId: PROJECT, repo: REPO, emit: () => {} });
    expect(await watcher.pollOnce()).toHaveLength(5);
    expect(await watcher.pollOnce()).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("passes the recency limit to the batched fetch", async () => {
    const { gh, calls } = batchedGh([[gqlPull(makePullRequest(7))]]);
    const watcher = new PullRequestWatcher({ gh, projectId: PROJECT, repo: REPO, emit: () => {}, first: 25 });
    expect(await watcher.pollOnce()).toHaveLength(1);
    expect(calls[0]).toContain("-F");
    expect(calls[0]).toContain("first=25");
  });

  it("start() wires emit and stop() works", async () => {
    vi.useFakeTimers();
    try {
      const { gh } = batchedGh([[gqlPull(makePullRequest(7))]]);
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
