import { describe, expect, it } from "vitest";
import {
  approvedGreen,
  blocker,
  ciRed,
  ciRedExhausted,
  issueComment,
  reReview,
  reviewChanges,
  spawnReviewer,
  spawnWorker,
  stalled,
} from "./delivery.js";

function expectOneLine(template: () => string): string {
  const line = template();
  expect(line).not.toMatch(/[\r\n]/);
  return line;
}

describe("delivery templates", () => {
  it("spawnWorker names the issue, branch, PR instruction, and URL", () => {
    const line = expectOneLine(() =>
      spawnWorker({
        number: 12,
        title: "Add\nrate limiting",
        url: "https://github.com/acme/api/issues/12",
        branch: "pideck/issue-12",
      }),
    );
    expect(line).toContain('#12 "Add rate limiting"');
    expect(line).toContain("branch pideck/issue-12");
    expect(line).toContain('"Closes #12"');
    expect(line).toContain("https://github.com/acme/api/issues/12");
  });

  it("ciRed lists failing checks and the attempt", () => {
    const line = expectOneLine(() =>
      ciRed({ failingChecks: ["lint", "test"], attempt: 2, maxAttempts: 5 }),
    );
    expect(line).toContain("CI failed: lint, test");
    expect(line).toContain("fix attempt 2 of 5");
  });

  it("ciRedExhausted tells the worker to comment its status and go idle", () => {
    const line = expectOneLine(() =>
      ciRedExhausted({ failingChecks: ["test"], attempt: 5, maxAttempts: 5 }),
    );
    expect(line).toContain("CI failed: test");
    expect(line).toContain("exhausted after 5");
    expect(line).toContain("pideck blocked");
  });

  it("reviewChanges points at the PR", () => {
    expect(expectOneLine(() => reviewChanges({ prNumber: 21 }))).toContain("PR #21");
  });

  it("issueComment points at the comment", () => {
    const line = expectOneLine(() =>
      issueComment({ issueNumber: 12, commentUrl: "https://github.com/acme/api/issues/12#issuecomment-1" }),
    );
    expect(line).toContain("New comment on issue #12");
    expect(line).toContain("issues/12#issuecomment-1");
  });

  it("spawnReviewer names the PR, repo, and one-review rule", () => {
    const line = expectOneLine(() => spawnReviewer({ prNumber: 21, repo: "acme/api" }));
    expect(line).toContain("PR #21");
    expect(line).toContain("acme/api");
    expect(line).toContain("exactly one review");
  });

  it("reReview asks for the next review round", () => {
    expect(expectOneLine(() => reReview({ prNumber: 21 }))).toContain(
      "New head on PR #21 — re-review",
    );
  });

  it("approvedGreen names both numbers and the alignment check", () => {
    expect(expectOneLine(() => approvedGreen({ prNumber: 21, issueNumber: 12 }))).toContain(
      "PR #21 for issue #12 is approved and green — alignment check.",
    );
  });

  it("blocker points at the issue comment", () => {
    const line = expectOneLine(() =>
      blocker({ issueNumber: 12, commentUrl: "https://github.com/acme/api/issues/12#issuecomment-9" }),
    );
    expect(line).toContain("blocked on issue #12");
    expect(line).toContain("issuecomment-9");
  });

  it("stalled reports the silent worker", () => {
    expect(expectOneLine(() => stalled({ issueNumber: 12, stallMinutes: 20 }))).toContain(
      "Worker for issue #12 has been silent for 20 minutes",
    );
  });
});