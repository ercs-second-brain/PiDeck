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
    prNumbers: [],
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
    associateWorkerPr(tracker, [makeWorker({ prNumbers: [5] })], effects, makePr({ body: "Closes #46" }));
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

  it("claims stacked/sibling PRs from the same namespace many-to-many (issue #470)", () => {
    const { tracker, actions, effects } = harness();
    const worker = makeWorker({ id: "worker-abc12345", issueNumber: 466 });
    // The worker already drives PR #7 from its primary branch; a stacked PR
    // branching under the same namespace claims the SAME worker for PR #8.
    worker.prNumbers = [7];
    associateWorkerPr(
      tracker,
      [worker],
      effects,
      makePr({ number: 8, headBranch: "pideck/worker-abc12345/stacked-fix" }),
    );
    expect(actions).toEqual([["set", "worker-abc12345", 8]]);
  });

  it("does not re-claim a PR the namespace worker already carries (issue #470)", () => {
    const { tracker, actions, effects } = harness();
    const worker = makeWorker({ id: "worker-abc12345", prNumbers: [7] });
    // The claiming guard skips a PR any worker already carries.
    associateWorkerPr(tracker, [worker], effects, makePr({ headBranch: "pideck/worker-abc12345" }));
    expect(actions).toEqual([]);
  });
});

describe("associateWorkerPr namespace verification on re-watch (issue #466)", () => {
  it("moves a heuristic mis-association to the worker the head branch names", () => {
    const { tracker, actions, effects } = harness();
    track(tracker, "worker-heuristic", "sess-heuristic");
    const previous = makeWorker({ id: "worker-heuristic", sessionId: "sess-heuristic", prNumbers: [7] });
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

  it("keeps the tracker when the namespace already matches (idempotent repair)", () => {
    const { tracker, actions, effects } = harness();
    track(tracker, "worker-1", "sess-1");
    const owner = makeWorker({ prNumbers: [7] });
    associateWorkerPr(tracker, [owner], effects, makePr({ headBranch: "pideck/worker-1" }));
    // The namespace agrees with the tracker; the re-watch only runs the
    // idempotent registry repair (setWorkerPr appends — no second entry).
    expect(actions).toEqual([["set", "worker-1", 7]]);
    expect(tracker.get(PROJECT, 7)?.workerId).toBe("worker-1");
  });

  it("does not verify when the head branch is not a worker branch", () => {
    const { tracker, actions, effects } = harness();
    track(tracker, "worker-9", "sess-9", "issue-46-fix");
    associateWorkerPr(tracker, [makeWorker()], effects, makePr());
    expect(actions).toEqual([]);
    expect(tracker.get(PROJECT, 7)?.workerId).toBe("worker-9");
  });

  it("keeps the tracked owner when the head branch names no ownable worker", () => {
    const { tracker, actions, effects } = harness();
    track(tracker, "worker-heuristic", "sess-heuristic");
    const previous = makeWorker({ id: "worker-heuristic", prNumbers: [7] });
    // The namespaced worker is terminal → no correction (the tracked loop
    // keeps driving until the worker resolves; #471 worker reuse will
    // redefine the eligibility rules).
    const gone = makeWorker({ id: "worker-abc12345", status: "archived" as WorkerStatus });
    associateWorkerPr(tracker, [previous, gone], effects, makePr({ headBranch: "pideck/worker-abc12345" }));
    expect(actions).toEqual([]);
    // A worker carrying another PR is NOT a blocker (issue #470 multi-PR):
    // the namespace says this PR is its too, so it takes it as well.
    const busy = makeWorker({ id: "worker-abc12345", prNumbers: [9] });
    associateWorkerPr(tracker, [previous, busy], effects, makePr({ headBranch: "pideck/worker-abc12345" }));
    expect(actions).toEqual([
      ["set", "worker-abc12345", 7],
      ["clear", "worker-heuristic"],
    ]);
    expect(tracker.get(PROJECT, 7)?.workerId).toBe("worker-abc12345");
  });

  it("moves ownership even when the namespaced worker already carries the PR number", () => {
    const { tracker, actions, effects } = harness();
    track(tracker, "worker-heuristic", "sess-heuristic");
    // Registry drifted from the tracker: the namespaced worker already
    // recorded PR #7 while the tracker still says worker-heuristic.
    const previous = makeWorker({ id: "worker-heuristic", prNumbers: [7] });
    const real = makeWorker({ id: "worker-abc12345", prNumbers: [7] });
    associateWorkerPr(tracker, [previous, real], effects, makePr({ headBranch: "pideck/worker-abc12345" }));
    expect(actions).toEqual([["set", "worker-abc12345", 7], ["clear", "worker-heuristic"]]);
    expect(tracker.get(PROJECT, 7)?.workerId).toBe("worker-abc12345");
  });
});