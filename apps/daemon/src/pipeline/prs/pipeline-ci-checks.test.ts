/**
 * PR-pipeline CI-failure prompt detail (issue #322): the autoFixCi prompt
 * names the failing checks (fetched fresh per prompt) and a failed lookup
 * degrades to the generic inspect-first prompt without blocking the fix
 * cycle. Split from pipeline-ci.test.ts (kiss max-lines budget).
 */

import { describe, expect, it } from "vitest";
import type { PullRequest } from "@pideck/shared";

import { driveLoop } from "./drive.js";
import { makeHarness, PROJECT, redFakePR } from "./harness.js";

/** A mapped open PR in the failure state (driveLoop-level test). */
function redPR(): PullRequest {
  return {
    projectId: PROJECT,
    number: 12,
    title: "PR 12",
    state: "open",
    ciStatus: "failure",
    reviewState: "none",
    headBranch: "agent/issue-7",
    baseBranch: "main",
    author: "worker",
    url: "https://github.com/o/r/pull/12",
    updatedAt: "2026-09-06T12:00:00Z",
  };
}

describe("PullRequestPipeline: CI-fix prompt detail (issue #322)", () => {
  it("names the failing checks in the fix prompt (issue #322)", async () => {
    const h = makeHarness();
    h.openList.push(12);
    h.prs.set(12, redFakePR());
    h.sessions.control.listWorkers()[0]!.prNumbers = [12];

    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
    // The harness fake's check run is named "build" — the prompt names it.
    expect(h.sessions.prompts[0]!.keys).toContain("Failing checks: build");
    expect(h.sessions.prompts[0]!.keys).toContain("gh run view --log-failed");
    expect(h.tracker.get(PROJECT, 12)!.fixAttempts).toBe(1);
  });

  it("a failed failing-checks lookup degrades the prompt to inspect-first and never blocks the fix cycle (issue #322)", async () => {
    const h = makeHarness();
    const worker = h.sessions.control.listWorkers()[0]!;
    const tracked = h.tracker.register({
      projectId: PROJECT,
      prNumber: 12,
      headBranch: "agent/issue-7",
      workerId: worker.id,
      sessionId: worker.sessionId,
      title: "PR 12",
    });
    const events = await driveLoop(tracked, { ...redPR(), ciStatus: "failure" }, "sha-1", [], {
      sessions: h.sessions.control,
      settings: () => ({ terminateOnMerge: true, autoFixCi: true, autoFixReviewComments: true, autoReview: false, workerReuseContextThreshold: 20 }),
      workerCap: () => undefined,
      repo: "o/r",
      failingChecks: () => Promise.reject(new Error("gh down")),
      // Issue #424: the review identity is a required context field; this
      // test never reaches the review cycle (red CI).
      reviewAccountUsername: () => "",
      maxFixAttempts: 3,
      fixPromptTimeoutMs: 15 * 60_000,
      now: h.now,
      fail: () => [],
    });
    expect(events).toEqual([]);
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.sessions.prompts[0]!.keys).toContain("Identify the failing checks first");
    expect(h.sessions.prompts[0]!.keys).toContain("attempt 1 of 3");
    expect(tracked.fixAttempts).toBe(1);
  });
});

