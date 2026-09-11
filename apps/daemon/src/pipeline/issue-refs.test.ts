/**
 * Unit tests for the deterministic worker↔PR association (issue #439):
 * PR claiming keys on the worker's head-branch namespace first
 * (`pideck/<workerId>`, issue #466), then on issue references in the PR's
 * title, head branch, or body (`Closes #N`) — daemon code over platform
 * truth, with no worker self-report path at all. Tracked PRs are
 * re-verified against the namespace on re-watch so heuristic
 * mis-associations self-correct (issue #466).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { PullRequest, Worker, WorkerStatus } from "@pideck/shared";

import { associateWorkerPr, type WorkerPrActions } from "./issue-refs.js";
import { PRTracker } from "./prs/tracker.js";

const PROJECT = "proj";

function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: "worker-1",
    projectId: PROJECT,
    sessionId: "sess-1",
    issueNumber: 46,
    prNumber: null,
    status: "running",
    statusMessage: "agent running",
    startedAt: "2026-09-06T12:00:00Z",
    updatedAt: "2026-09-06T12:00:00Z",
    ...overrides,
  };
}

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    projectId: PROJECT,
    number: 7,
    title: "Some change",
    state: "open",
    ciStatus: "pending",
    reviewState: "none",
    headBranch: "feature-x",
    baseBranch: "main",
    author: "octo-bot",
    url: "https://github.com/o/r/pull/7",
    updatedAt: "2026-09-06T12:00:00Z",
    ...overrides,
  };
}

function harness() {
  const tracker = new PRTracker(path.join(mkdtempSync(path.join(tmpdir(), "pideck-issuerefs-")), "prs.json"));
  const actions: Array<["set" | "clear", string, number?]> = [];
  const effects: WorkerPrActions = {
    setWorkerPr: (workerId, prNumber) => actions.push(["set", workerId, prNumber]),
    clearWorkerPr: (workerId) => actions.push(["clear", workerId]),
  };
  return { tracker, actions, effects };
}

/** Registers PR #7 in the tracker as owned by `workerId` (pre-tracked state). */
function track(tracker: ReturnType<typeof harness>["tracker"], workerId: string, sessionId: string, headBranch = "feature-x"): void {
  tracker.register({
    projectId: PROJECT,
    prNumber: 7,
    headBranch,
    workerId,
    sessionId,
    title: "Some change",
  });
}

describe("associateWorkerPr (deterministic PR claiming, issue #439)", () => {
  it("claims via the `Closes #N` closing keyword in the PR body", () => {
    const { tracker, actions, effects } = harness();
    const worker = makeWorker();
    associateWorkerPr(tracker, [worker], effects, makePr({ body: "Fixes the loop.\n\nCloses #46" }));
    expect(actions).toEqual([["set", "worker-1", 7]]);
  });

  it("claims via an issue reference in the title", () => {
    const { tracker, actions, effects } = harness();
    associateWorkerPr(tracker, [makeWorker()], effects, makePr({ title: "Resolve #46: fix the loop" }));
    expect(actions).toEqual([["set", "worker-1", 7]]);
  });

  it("claims via an issue reference in the head branch", () => {
    const { tracker, actions, effects } = harness();
    associateWorkerPr(tracker, [makeWorker()], effects, makePr({ headBranch: "issue-46-fix" }));
    expect(actions).toEqual([["set", "worker-1", 7]]);
  });

  it("does not claim a PR with no issue references", () => {
    const { tracker, actions, effects } = harness();
    associateWorkerPr(tracker, [makeWorker()], effects, makePr());
    expect(actions).toEqual([]);
  });

  it("does not claim a PR whose references match no worker's issue", () => {
    const { tracker, actions, effects } = harness();
    associateWorkerPr(tracker, [makeWorker({ issueNumber: 50 })], effects, makePr({ body: "Closes #46" }));
    expect(actions).toEqual([]);
  });

  it("does not claim for a worker in a terminal status", () => {
    const { tracker, actions, effects } = harness();
    associateWorkerPr(tracker, [makeWorker({ status: "done" as WorkerStatus })], effects, makePr({ body: "Closes #46" }));
    expect(actions).toEqual([]);
  });

  it("never re-claims: a worker with a recorded PR is skipped", () => {
    const { tracker, actions, effects } = harness();
    associateWorkerPr(tracker, [makeWorker({ prNumber: 5 })], effects, makePr({ body: "Closes #46" }));
    expect(actions).toEqual([]);
  });

  it("skips a PR the tracker already knows", () => {
    const { tracker, actions, effects } = harness();
    track(tracker, "worker-9", "sess-9");
    associateWorkerPr(tracker, [makeWorker()], effects, makePr({ body: "Closes #46" }));
    expect(actions).toEqual([]);
  });
});

describe("associateWorkerPr evidence tiers (issues #441, #466)", () => {
  it("claims the worker the head-branch namespace names (issue #466)", () => {
    const { tracker, actions, effects } = harness();
    const author = makeWorker({ id: "worker-abc12345", issueNumber: 466 });
    associateWorkerPr(
      tracker,
      [author],
      effects,
      makePr({ headBranch: `pideck/${author.id}`, title: "Some change", body: undefined }),
    );
    expect(actions).toEqual([["set", "worker-abc12345", 7]]);
  });

  it("the head-branch namespace outranks an issue reference naming another worker's issue", () => {
    const { tracker, actions, effects } = harness();
    const namespaced = makeWorker({ id: "worker-abc12345", issueNumber: 466 });
    const referenced = makeWorker({ id: "worker-other", issueNumber: 46 });
    // The title references #46 — but the head branch names worker-abc12345,
    // the deterministic key: the namespace tier wins.
    associateWorkerPr(
      tracker,
      [referenced, namespaced],
      effects,
      makePr({ headBranch: "pideck/worker-abc12345", title: "Resolve #46: fix the loop" }),
    );
    expect(actions).toEqual([["set", "worker-abc12345", 7]]);
  });

  it("ignores a namespace-looking branch whose suffix is no worker id", () => {
    const { tracker, actions, effects } = harness();
    // Suffixes match by exact equality, not by loose substring or issue-ref.
    associateWorkerPr(
      tracker,
      [makeWorker()],
      effects,
      makePr({ headBranch: `pideck/${makeWorker().id}-renamed` }),
    );
    expect(actions).toEqual([]);
  });

  it("falls back to the title reference when the branch is not a worker branch", () => {
    const { tracker, actions, effects } = harness();
    associateWorkerPr(tracker, [makeWorker()], effects, makePr({ title: "Resolve #46: fix the loop" }));
    expect(actions).toEqual([["set", "worker-1", 7]]);
  });

  it("falls back to issue references when the namespaced worker is terminal", () => {
    const { tracker, actions, effects } = harness();
    const gone = makeWorker({ id: "worker-abc12345", status: "archived" as WorkerStatus });
    const running = makeWorker({ id: "worker-other", issueNumber: 46 });
    associateWorkerPr(
      tracker,
      [gone, running],
      effects,
      makePr({ headBranch: "pideck/worker-abc12345", title: "Resolve #46" }),
    );
    expect(actions).toEqual([["set", "worker-other", 7]]);
  });
});

describe("associateWorkerPr namespace verification on re-watch (issue #466)", () => {
  it("moves a heuristic mis-association to the worker the head branch names", () => {
    const { tracker, actions, effects } = harness();
    track(tracker, "worker-heuristic", "sess-heuristic");
    const previous = makeWorker({ id: "worker-heuristic", sessionId: "sess-heuristic", prNumber: 7 });
    const real = makeWorker({ id: "worker-abc12345", issueNumber: 50 });
    associateWorkerPr(
      tracker,
      [previous, real],
      effects,
      makePr({ headBranch: "pideck/worker-abc12345" }),
    );
    // The namespaced worker takes over, the previous owner is cleared, and
    // the tracker now drives the loop against the right worker.
    expect(actions).toEqual([
      ["set", "worker-abc12345", 7],
      ["clear", "worker-heuristic"],
    ]);
    expect(tracker.get(PROJECT, 7)?.workerId).toBe("worker-abc12345");
    expect(tracker.get(PROJECT, 7)?.sessionId).toBe("sess-1");
  });

  it("does not move ownership when the namespace already matches", () => {
    const { tracker, actions, effects } = harness();
    track(tracker, "worker-1", "sess-1");
    const owner = makeWorker({ prNumber: 7 });
    associateWorkerPr(tracker, [owner], effects, makePr({ headBranch: "pideck/worker-1" }));
    expect(actions).toEqual([]);
    expect(tracker.get(PROJECT, 7)?.workerId).toBe("worker-1");
  });

  it("does not verify when the head branch is not a worker branch", () => {
    const { tracker, actions, effects } = harness();
    track(tracker, "worker-9", "sess-9", "issue-46-fix");
    associateWorkerPr(tracker, [makeWorker()], effects, makePr());
    expect(actions).toEqual([]);
    expect(tracker.get(PROJECT, 7)?.workerId).toBe("worker-9");
  });

  it("keeps the tracked owner when the namespaced worker cannot take the PR", () => {
    const { tracker, actions, effects } = harness();
    track(tracker, "worker-heuristic", "sess-heuristic");
    // Namespaced worker is terminal → no correction.
    const gone = makeWorker({ id: "worker-abc12345", status: "archived" as WorkerStatus });
    associateWorkerPr(tracker, [gone], effects, makePr({ headBranch: "pideck/worker-abc12345" }));
    // Namespaced worker is already associated to a different PR → no move.
    const busy = makeWorker({ id: "worker-abc12345", prNumber: 9 });
    associateWorkerPr(tracker, [busy], effects, makePr({ headBranch: "pideck/worker-abc12345" }));
    expect(actions).toEqual([]);
    expect(tracker.get(PROJECT, 7)?.workerId).toBe("worker-heuristic");
  });

  it("moves ownership even when the namespaced worker already carries the PR number", () => {
    const { tracker, actions, effects } = harness();
    track(tracker, "worker-heuristic", "sess-heuristic");
    // Registry drifted from the tracker: the namespaced worker already
    // recorded PR #7 while the tracker still says worker-heuristic.
    const previous = makeWorker({ id: "worker-heuristic", prNumber: 7 });
    const real = makeWorker({ id: "worker-abc12345", prNumber: 7 });
    associateWorkerPr(tracker, [previous, real], effects, makePr({ headBranch: "pideck/worker-abc12345" }));
    expect(actions).toEqual([["set", "worker-abc12345", 7], ["clear", "worker-heuristic"]]);
    expect(tracker.get(PROJECT, 7)?.workerId).toBe("worker-abc12345");
  });
});