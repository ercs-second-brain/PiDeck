import { describe, expect, it } from "vitest";
import type { PullRequest } from "@pideck/shared";

import type { PRReviewComment } from "../../github/pulls.js";
import { buildAddressReviewPrompt, buildCiFixPrompt, buildReReviewPrompt, buildReviewAgentPrompt, buildReviewCommentsPrompt } from "./prompts.js";

const PR: PullRequest = {
  projectId: "proj",
  number: 12,
  title: "Add PR lifecycle loop",
  state: "open",
  ciStatus: "failure",
  reviewState: "none",
  headBranch: "agent/issue-7",
  baseBranch: "main",
  author: "worker",
  url: "https://github.com/o/r/pull/12",
  updatedAt: "2026-09-06T12:00:00Z",
};

const COMMENT: PRReviewComment = {
  id: 101,
  author: "alice",
  body: "Rename this\tvariable\nplease",
  path: "src/a.ts",
  line: 42,
  inReplyToId: null,
  url: "https://github.com/o/r/pull/12#discussion_r101",
  createdAt: "2026-09-06T12:00:00Z",
  updatedAt: "2026-09-06T12:00:00Z",
};

describe("PR prompts", () => {
  it("ci fix prompt is a single line naming PR, attempt bound, and branch", () => {
    const prompt = buildCiFixPrompt(PR, { attempt: 2, maxAttempts: 5 });
    expect(prompt).not.toContain("\n");
    expect(prompt).toContain("CI is failing");
    expect(prompt).toContain("PR #12");
    expect(prompt).toContain("attempt 2 of 5");
    expect(prompt).toContain("`agent/issue-7`");
    expect(prompt).toContain("Do not open a new PR");
  });

  it("ci fix prompt can carry review comments to address in the same push", () => {
    const prompt = buildCiFixPrompt(PR, { attempt: 1, maxAttempts: 5, comments: [COMMENT] });
    expect(prompt).toContain("alice on src/a.ts:42");
    expect(prompt).toContain("Rename this variable please");
  });

  it("ci fix prompt names the failing checks and the log command (issue #322)", () => {
    const prompt = buildCiFixPrompt(PR, { attempt: 1, maxAttempts: 5, failingChecks: ["build", "unit tests"] });
    expect(prompt).toContain("Failing checks: build, unit tests");
    expect(prompt).toContain("gh run view --log-failed");
    expect(prompt).toContain("fix the failures, commit, and push");
  });

  it("ci fix prompt degrades to inspect-first when no failing checks were resolved", () => {
    const prompt = buildCiFixPrompt(PR, { attempt: 1, maxAttempts: 5 });
    expect(prompt).not.toContain("Failing checks:");
    expect(prompt).toContain("Identify the failing checks first");
    expect(prompt).toContain("fix the failures, commit, and push");
  });

  it("review comments prompt lists every comment with file and line", () => {
    const prompt = buildReviewCommentsPrompt(PR, [
      COMMENT,
      { ...COMMENT, id: 102, author: null, path: "src/b.ts", line: null, body: "Add tests" },
    ]);
    expect(prompt).not.toContain("\n");
    expect(prompt).toContain("2 new review comment(s) on your PR #12");
    expect(prompt).toContain("(1) alice on src/a.ts:42");
    expect(prompt).toContain("(2) reviewer on src/b.ts — \"Add tests\"");
    expect(prompt).toContain("follow-up commit");
  });

  it("review agent prompt is a single line naming the PR, repo, and the gh review path", () => {
    const prompt = buildReviewAgentPrompt(PR, { projectId: "proj", repo: "o/r" });
    expect(prompt).not.toContain("\n");
    expect(prompt).toContain("review agent for PR #12");
    expect(prompt).toContain("--kind researcher");
    expect(prompt).toContain("wait for its report before posting your review");
    expect(prompt).toContain("gh pr diff 12 --repo o/r");
    // Issue #407: the round ends in ONE real review via gh pr review, with
    // inline comments attached to that same submission via a JSON body.
    expect(prompt).toContain("gh pr review 12 --repo o/r --request-changes");
    expect(prompt).toContain("gh pr review 12 --repo o/r --approve");
    expect(prompt).toContain("gh pr review 12 --repo o/r --comment");
    expect(prompt).toContain("--input reviews.json");
    expect(prompt).toContain("Do not push commits");
  });

  it("re-review prompt asks for a fresh review after new commits", () => {
    const prompt = buildReReviewPrompt(PR, { projectId: "proj", repo: "o/r" });
    expect(prompt).not.toContain("\n");
    expect(prompt).toContain("New commits were pushed to PR #12");
    expect(prompt).toContain("Re-review the updated diff");
    expect(prompt).toContain("gh pr review 12 --repo o/r");
  });

  it("address-review prompt tells the author to fetch findings from the review body too, with the round bound (issue #440)", () => {
    const prompt = buildAddressReviewPrompt(PR, { attempt: 2, maxAttempts: 5 });
    expect(prompt).not.toContain("\n");
    expect(prompt).toContain("requested changes on your PR #12");
    expect(prompt).toContain("Fetch the findings");
    expect(prompt).toContain("Fix round 2 of 5");
    expect(prompt).not.toContain("review-comments skill");
    expect(prompt).toContain("`agent/issue-7`");
    expect(prompt).toContain("Do not open a new PR");
  });
});
