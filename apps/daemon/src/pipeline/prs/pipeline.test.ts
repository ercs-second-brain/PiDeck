import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PullRequest, Worker, WorkerStatus } from "@agentskiss/shared";

import { GhClient } from "../../github/gh.js";
import { restPull } from "../../testing/fixtures.js";
import type { PRPipelineEvent } from "./events.js";
import { DEFAULT_MAX_FIX_ATTEMPTS, PullRequestPipeline, type PRSessionControl } from "./pipeline.js";
import { PRTracker } from "./tracker.js";

const PROJECT = "proj";
const REPO = { owner: "o", repo: "r" };
const BASE_TIME = Date.parse("2026-09-06T12:00:00Z");

// ---------------------------------------------------------------------------
// Fake GitHub (gh runner)
// ---------------------------------------------------------------------------

interface FakePR {
  pull: Record<string, unknown>;
  checkRuns: unknown;
  reviews: unknown[];
  comments: unknown[];
}

function checkRuns(conclusion: "failure" | "success"): unknown {
  return { total_count: 1, check_runs: [{ status: "completed", conclusion }] };
}

function restComment(id: number, body: string, overrides: Partial<{ author: string; path: string; line: number | null }> = {}): Record<string, unknown> {
  return {
    id,
    user: { login: overrides.author ?? "alice" },
    body,
    path: overrides.path ?? "src/a.ts",
    line: overrides.line ?? 42,
    in_reply_to_id: null,
    html_url: `https://github.com/o/r/pull/12#discussion_r${id}`,
    created_at: "2026-09-06T12:00:00Z",
    updated_at: "2026-09-06T12:00:00Z",
  };
}

/** PR #12 open, red CI, no reviews, no comments — the common starting point. */
function redFakePR(number = 12, overrides: Parameters<typeof restPull>[1] = {}): FakePR {
  return { pull: restPull(number, overrides), checkRuns: checkRuns("failure"), reviews: [], comments: [] };
}

function fakeGh(prs: Map<number, FakePR>, openList: number[]): GhClient {
  // check-runs paths carry the commit SHA, not the PR number; the fake
  // tracks which PR's fetch is in flight (single pull first, then its
  // enrichment) to route those calls.
  let current = 0;
  return new GhClient(async (args) => {
    const p = args[1] ?? "";
    const json = (body: unknown) => ({ stdout: JSON.stringify(body), stderr: "" });
    if (p.includes("/pulls?state=open")) return json(openList.map((n) => prs.get(n)!.pull));
    const single = /\/pulls\/(\d+)$/.exec(p);
    if (single) {
      current = Number(single[1] ?? 0);
      return json(prs.get(current)!.pull);
    }
    const nested = /\/pulls\/(\d+)\//.exec(p);
    if (nested !== null) current = Number(nested[1] ?? 0);
    const pr = prs.get(current)!;
    if (p.includes("/comments")) return json(pr.comments);
    if (p.includes("/reviews")) return json(pr.reviews);
    if (p.includes("/check-runs")) return json(pr.checkRuns);
    throw new Error(`unexpected gh args: ${JSON.stringify(args)}`);
  });
}

// ---------------------------------------------------------------------------
// Fake session control
// ---------------------------------------------------------------------------

interface SentPrompt {
  sessionId: string;
  keys: string;
}

interface StatusChange {
  workerId: string;
  status: WorkerStatus;
  statusMessage?: string;
}

function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: "worker-1",
    projectId: PROJECT,
    sessionId: "sess-1",
    issueNumber: 7,
    prNumber: null,
    status: "running",
    statusMessage: null,
    startedAt: "2026-09-06T12:00:00Z",
    updatedAt: "2026-09-06T12:00:00Z",
    ...overrides,
  };
}

function fakeSessions(workers: Worker[]): { control: PRSessionControl; prompts: SentPrompt[]; statuses: StatusChange[] } {
  const prompts: SentPrompt[] = [];
  const statuses: StatusChange[] = [];
  const byId = new Map(workers.map((w) => [w.id, w]));
  const control: PRSessionControl = {
    listWorkers: (filter = {}) => workers.filter((w) => filter.projectId === undefined || w.projectId === filter.projectId),
    getWorker: (id) => byId.get(id),
    updateWorkerStatus: (workerId, status, statusMessage) => {
      const worker = byId.get(workerId);
      if (worker === undefined) throw new Error(`unknown worker: ${workerId}`);
      worker.status = status;
      worker.statusMessage = statusMessage ?? null;
      statuses.push({ workerId, status, statusMessage });
      return worker;
    },
    sendKeys: async (sessionId, keys) => {
      prompts.push({ sessionId, keys });
    },
  };
  return { control, prompts, statuses };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  prs: Map<number, FakePR>;
  openList: number[];
  gh: GhClient;
  sessions: ReturnType<typeof fakeSessions>;
  tracker: PRTracker;
  emit: PRPipelineEvent[];
  now: () => Date;
  advance(ms: number): void;
  pipeline: PullRequestPipeline;
  poll(): Promise<PRPipelineEvent[]>;
}

function makeHarness(
  options: { workers?: Worker[]; maxFixAttempts?: number; fixPromptTimeoutMs?: number; trackerPath?: string } = {},
): Harness {
  const prs = new Map<number, FakePR>();
  const openList: number[] = [];
  const gh = fakeGh(prs, openList);
  const sessions = fakeSessions(options.workers ?? [makeWorker()]);
  const trackerPath =
    options.trackerPath ?? path.join(mkdtempSync(path.join(tmpdir(), "agentskiss-prpipeline-")), "prs.json");
  const tracker = new PRTracker(trackerPath);
  const emitted: PRPipelineEvent[] = [];
  let clock = BASE_TIME;
  const now = () => new Date(clock);
  const pipeline = new PullRequestPipeline({
    gh,
    projectId: PROJECT,
    repo: REPO,
    sessions: sessions.control,
    tracker,
    emit: (event) => emitted.push(event),
    maxFixAttempts: options.maxFixAttempts,
    fixPromptTimeoutMs: options.fixPromptTimeoutMs,
    now,
  });
  return {
    prs,
    openList,
    gh,
    sessions,
    tracker,
    emit: emitted,
    now,
    advance: (ms: number) => {
      clock += ms;
    },
    pipeline,
    poll: () => pipeline.pollOnce(),
  };
}

function prEvents(events: PRPipelineEvent[]): PRPipelineEvent[] {
  return events.filter((e) => e.type === "kanban.pr.card" || e.type === "kanban.pr.failed");
}

describe("PullRequestPipeline", () => {
  it("tracks a PR through the opened event path and ignores PRs with no owning worker", async () => {
    const h = makeHarness();
    h.openList.push(12);
    h.prs.set(12, redFakePR());

    // Worker has no prNumber yet → PR is not tracked.
    expect(await h.poll()).toEqual([]);
    expect(h.tracker.list()).toEqual([]);

    // The wiring records the PR on the worker (SessionManager.setWorkerPr).
    h.sessions.control.listWorkers()[0]!.prNumber = 12;

    const events = prEvents(await h.poll());
    // Discovery card (CI not yet enriched → in_progress), then the enriched
    // red-CI card moves to in_review via the shared kanban mapping.
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "kanban.pr.card",
      card: { kind: "pull_request", number: 12, column: "in_progress", workerId: "worker-1", projectId: PROJECT },
    });
    expect(events[1]).toMatchObject({ card: { number: 12, column: "in_review" } });
    // A red PR is prompted in the same pass it is tracked.
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ state: "fixing", fixAttempts: 1 });
  });

  it("red → fix prompt → worker pushes → green (no manual commands)", async () => {
    const h = makeHarness();
    h.openList.push(12);
    h.prs.set(12, redFakePR());
    const worker = h.sessions.control.listWorkers()[0]!;
    worker.prNumber = 12;

    // Poll 1: red → CI-fix prompt to the worker's session.
    const events = await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.sessions.prompts[0]).toEqual({ sessionId: "sess-1", keys: expect.stringContaining("CI is failing on your PR #12") });
    expect(h.sessions.prompts[0]!.keys).toContain("attempt 1 of " + DEFAULT_MAX_FIX_ATTEMPTS);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ state: "fixing", fixAttempts: 1 });
    expect(h.sessions.statuses.at(-1)).toMatchObject({ workerId: "worker-1", status: "fixing_ci" });
    expect(prEvents(events).at(-1)).toMatchObject({ card: { column: "in_review" } });

    // Poll 2: worker has not pushed yet (same head SHA) → no duplicate prompt.
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);

    // Poll 3: worker pushed, CI green → no prompt, attempt counter reset.
    const fake = h.prs.get(12)!;
    fake.pull = restPull(12, { sha: "sha-2" });
    fake.checkRuns = checkRuns("success");
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ state: "watching", fixAttempts: 0 });
    expect(h.sessions.statuses.at(-1)).toMatchObject({ status: "awaiting_ci" });

    // Poll 4: approved → the card already sits in in_review (settled CI) per
    // the shared kanban mapping — no new card event, no further prompts.
    // (Under the unified mapping only a merge moves a PR card to done.)
    fake.reviews = [{ user: { login: "alice" }, state: "APPROVED", submitted_at: "2026-09-06T12:10:00Z" }];
    const events4 = prEvents(await h.poll());
    expect(events4).toHaveLength(0);
    expect(h.sessions.prompts).toHaveLength(1);
  });

  it("delivers review comments to the worker and handles comments arriving after fixes", async () => {
    const h = makeHarness();
    h.openList.push(12);
    h.prs.set(12, {
      pull: restPull(12, { sha: "sha-1" }),
      checkRuns: checkRuns("success"),
      reviews: [],
      comments: [],
    });
    h.sessions.control.listWorkers()[0]!.prNumber = 12;
    await h.poll(); // discover + track, nothing to do
    expect(h.sessions.prompts).toHaveLength(0);

    // New review comment → addressing prompt without manual prompting.
    h.prs.get(12)!.comments = [restComment(101, "Rename this variable")];
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.sessions.prompts[0]!.keys).toContain("1 new review comment(s) on your PR #12");
    expect(h.sessions.prompts[0]!.keys).toContain("Rename this variable");
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ state: "addressing", lastSeenCommentId: 101 });
    expect(h.sessions.statuses.at(-1)).toMatchObject({ status: "addressing_review" });

    // Not yet pushed → comment is not re-delivered.
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);

    // Worker pushes a follow-up commit → back to watching.
    const fake = h.prs.get(12)!;
    fake.pull = restPull(12, { sha: "sha-2" });
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("watching");

    // A comment arriving after the fix is delivered too.
    fake.comments = [restComment(101, "Rename this variable"), restComment(102, "Also add tests")];
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(2);
    expect(h.sessions.prompts[1]!.keys).toContain("Also add tests");
    expect(h.tracker.get(PROJECT, 12)!.lastSeenCommentId).toBe(102);
  });

  it("bounds the fix loop: exhausted attempts mark the PR failed and stop prompting", async () => {
    const h = makeHarness({ maxFixAttempts: 2 });
    h.openList.push(12);
    h.prs.set(12, redFakePR());
    h.sessions.control.listWorkers()[0]!.prNumber = 12;

    // Attempt 1 (sha-1), worker pushes, still red.
    expect((await h.poll()).length).toBeGreaterThan(0);
    h.prs.get(12)!.pull = restPull(12, { sha: "sha-2" });
    expect((await h.poll()).filter((e) => e.type === "kanban.pr.failed")).toEqual([]);

    // Attempt 2, worker pushes, still red → limit reached.
    h.prs.get(12)!.pull = restPull(12, { sha: "sha-3" });
    const events = await h.poll();
    expect(h.sessions.prompts).toHaveLength(2); // exactly maxFixAttempts prompts
    const failed = events.filter((e) => e.type === "kanban.pr.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      type: "kanban.pr.failed",
      projectId: PROJECT,
      prNumber: 12,
      workerId: "worker-1",
      reason: expect.stringContaining("fix_attempt_limit_exhausted"),
    });
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("failed");
    expect(h.sessions.statuses.at(-1)).toMatchObject({ status: "failed" });

    // Terminal: further polls do nothing at all.
    h.prs.get(12)!.pull = restPull(12, { sha: "sha-4" });
    expect(await h.poll()).toEqual([]);
    expect(h.sessions.prompts).toHaveLength(2);
  });

  it("re-prompts when the worker never acts on a fix prompt (stale timeout, still bounded)", async () => {
    const h = makeHarness({ maxFixAttempts: 2, fixPromptTimeoutMs: 1000 });
    h.openList.push(12);
    h.prs.set(12, redFakePR());
    h.sessions.control.listWorkers()[0]!.prNumber = 12;

    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
    h.advance(2000);
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(2);
    expect(h.tracker.get(PROJECT, 12)!.fixAttempts).toBe(2);
    h.advance(2000);
    await h.poll(); // would be attempt 3 — past the limit
    expect(h.sessions.prompts).toHaveLength(2);
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("failed");
  });

  it("marks the card done and the worker done on merge", async () => {
    const h = makeHarness();
    h.openList.push(12);
    h.prs.set(12, {
      pull: restPull(12),
      checkRuns: checkRuns("success"),
      reviews: [{ user: { login: "alice" }, state: "APPROVED", submitted_at: "2026-09-06T12:05:00Z" }],
      comments: [],
    });
    h.sessions.control.listWorkers()[0]!.prNumber = 12;

    const first = prEvents(await h.poll());
    expect(first.at(-1)).toMatchObject({ card: { column: "in_review" } });

    // Merge → done card + worker done; merged PRs drop out of the open list.
    h.prs.get(12)!.pull = restPull(12, { merged: true, closed: true });
    h.openList.length = 0;
    const events = await h.poll();
    const mergeCards = events.filter((e) => e.type === "kanban.pr.card");
    expect(mergeCards).toHaveLength(1);
    expect(mergeCards[0]).toMatchObject({ card: { column: "done" } });
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("done");
    expect(h.sessions.statuses.at(-1)).toMatchObject({ status: "done" });
    expect(await h.poll()).toEqual([]);
  });

  it("handleWatcherEvent registers worker PRs before the next poll and restarts cleanly", async () => {
    const h = makeHarness();
    h.prs.set(12, redFakePR());
    const worker = h.sessions.control.listWorkers()[0]!;
    worker.prNumber = 12;

    const pr: PullRequest = {
      projectId: PROJECT,
      number: 12,
      title: "PR 12",
      state: "open",
      ciStatus: "failure",
      reviewState: "none",
      headBranch: "agent/issue-12",
      baseBranch: "main",
      author: "worker",
      url: "https://github.com/o/r/pull/12",
      updatedAt: "2026-09-06T12:00:00Z",
    };
    const events = h.pipeline.handleWatcherEvent({ type: "pull_request.opened", at: h.now().toISOString(), pullRequest: pr });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "kanban.pr.card", card: { number: 12, column: "in_review" } });

    // The next poll processes the tracked PR even though the discovery list
    // has not been refreshed (simulating the watcher being the only source).
    h.openList.length = 0;
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);

    // Duplicate events do not double-track.
    expect(h.pipeline.handleWatcherEvent({ type: "pull_request.updated", at: h.now().toISOString(), pullRequest: pr })).toEqual([]);
    expect(h.tracker.list()).toHaveLength(1);
  });

  it("restart: persisted tracker + registry reconcile resumes the loop and prunes lost workers", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agentskiss-prpipeline-"));
    const filePath = path.join(dir, "prs.json");
    const worker = makeWorker({ prNumber: 12 });
    const h = makeHarness({ workers: [worker], trackerPath: filePath });
    h.openList.push(12);
    h.prs.set(12, redFakePR());
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("fixing");

    // Daemon restart: fresh tracker over the same file, fresh pipeline.
    const sessions2 = fakeSessions([worker]);
    const tracker2 = new PRTracker(filePath);
    const emitted2: PRPipelineEvent[] = [];
    const pipeline2 = new PullRequestPipeline({
      gh: h.gh,
      projectId: PROJECT,
      repo: REPO,
      sessions: sessions2.control,
      tracker: tracker2,
      emit: (event) => emitted2.push(event),
      now: h.now,
    });
    const reconcileEvents = pipeline2.reconcile();
    expect(reconcileEvents).toEqual([]); // worker still registered → nothing pruned
    expect(tracker2.get(PROJECT, 12)!.state).toBe("fixing");

    // The loop resumes: same head SHA → no duplicate prompt.
    await pipeline2.pollOnce();
    expect(sessions2.prompts).toHaveLength(0);

    // Worker pushes a fix and CI goes green → ends green without manual commands.
    h.prs.get(12)!.pull = restPull(12, { sha: "sha-2" });
    h.prs.get(12)!.checkRuns = checkRuns("success");
    await pipeline2.pollOnce();
    expect(sessions2.prompts).toHaveLength(0);
    expect(tracker2.get(PROJECT, 12)).toMatchObject({ state: "watching", fixAttempts: 0 });

    // If the worker record is gone, reconcile fails the tracked PR.
    const sessions3 = fakeSessions([]);
    const pipeline3 = new PullRequestPipeline({
      gh: h.gh,
      projectId: PROJECT,
      repo: REPO,
      sessions: sessions3.control,
      tracker: tracker2,
      emit: (event) => emitted2.push(event),
      now: h.now,
    });
    tracker2.get(PROJECT, 12)!.state = "watching";
    const lost = pipeline3.reconcile();
    expect(lost).toHaveLength(2);
    expect(lost[1]).toMatchObject({ type: "kanban.pr.failed", prNumber: 12, reason: "worker_lost" });
    expect(tracker2.get(PROJECT, 12)!.state).toBe("failed");
  });
});
