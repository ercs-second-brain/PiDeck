/**
 * Unit tests for the deterministic worker↔PR association (issue #439):
 * PR claiming keys on issue references in the PR's title, head branch, or
 * body (`Closes #N`) — daemon code over platform truth, with no worker
 * self-report path at all.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { PullRequest, Worker, WorkerStatus } from "@pideck/shared";

import { associateWorkerPr } from "./issue-refs.js";
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
  const claimed: Array<[string, number]> = [];
  const setWorkerPr = (workerId: string, prNumber: number) => claimed.push([workerId, prNumber]);
  return { tracker, claimed, setWorkerPr };
}

describe("associateWorkerPr (deterministic PR claiming, issue #439)", () => {
  it("claims via the `Closes #N` closing keyword in the PR body", () => {
    const { tracker, claimed, setWorkerPr } = harness();
    const worker = makeWorker();
    associateWorkerPr(tracker, [worker], setWorkerPr, makePr({ body: "Fixes the loop.\n\nCloses #46" }));
    expect(claimed).toEqual([["worker-1", 7]]);
  });

  it("claims via an issue reference in the title", () => {
    const { tracker, claimed, setWorkerPr } = harness();
    associateWorkerPr(
      tracker,
      [makeWorker()],
      setWorkerPr,
      makePr({ title: "Resolve #46: fix the loop" }),
    );
    expect(claimed).toEqual([["worker-1", 7]]);
  });

  it("claims via an issue reference in the head branch", () => {
    const { tracker, claimed, setWorkerPr } = harness();
    associateWorkerPr(
      tracker,
      [makeWorker()],
      setWorkerPr,
      makePr({ headBranch: "issue-46-fix" }),
    );
    expect(claimed).toEqual([["worker-1", 7]]);
  });

  it("does not claim a PR with no issue references", () => {
    const { tracker, claimed, setWorkerPr } = harness();
    associateWorkerPr(tracker, [makeWorker()], setWorkerPr, makePr());
    expect(claimed).toEqual([]);
  });

  it("does not claim a PR whose references match no worker's issue", () => {
    const { tracker, claimed, setWorkerPr } = harness();
    associateWorkerPr(
      tracker,
      [makeWorker({ issueNumber: 50 })],
      setWorkerPr,
      makePr({ body: "Closes #46" }),
    );
    expect(claimed).toEqual([]);
  });

  it("does not claim for a worker in a terminal status", () => {
    const { tracker, claimed, setWorkerPr } = harness();
    associateWorkerPr(
      tracker,
      [makeWorker({ status: "done" as WorkerStatus })],
      setWorkerPr,
      makePr({ body: "Closes #46" }),
    );
    expect(claimed).toEqual([]);
  });

  it("never re-claims: a worker with a recorded PR is skipped", () => {
    const { tracker, claimed, setWorkerPr } = harness();
    associateWorkerPr(
      tracker,
      [makeWorker({ prNumber: 5 })],
      setWorkerPr,
      makePr({ body: "Closes #46" }),
    );
    expect(claimed).toEqual([]);
  });

  it("skips a PR the tracker already knows", () => {
    const { tracker, claimed, setWorkerPr } = harness();
    tracker.register({
      projectId: PROJECT,
      prNumber: 7,
      headBranch: "feature-x",
      workerId: "worker-9",
      sessionId: "sess-9",
      title: "Some change",
    });
    associateWorkerPr(
      tracker,
      [makeWorker()],
      setWorkerPr,
      makePr({ body: "Closes #46" }),
    );
    expect(claimed).toEqual([]);
  });
});
