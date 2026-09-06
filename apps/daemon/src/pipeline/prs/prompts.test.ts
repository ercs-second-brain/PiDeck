import { describe, expect, it } from "vitest";
import type { PullRequest } from "@agentskiss/shared";

import type { PRReviewComment } from "../../github/pulls.js";
import { buildCiFixPrompt, buildReviewCommentsPrompt } from "./prompts.js";

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
});
