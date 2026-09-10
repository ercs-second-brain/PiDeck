/**
 * Review-submission retrieval (issue #407): the PR loop's review-based
 * triggers key off the latest review submission (any state — a COMMENTED
 * review still completes a round). Split from pulls.test.ts (kiss budget).
 */

import { describe, expect, it } from "vitest";

import { GhClient } from "./gh.js";
import { getLatestReview } from "./reviews.js";

const REPO = { owner: "ercs-second-brain", repo: "agentsKISS" };

function reviewsGh(list: Array<{ user: string; state: string }>): GhClient {
  return new GhClient(async (args) => {
    expect(args[1]).toBe("/repos/ercs-second-brain/agentsKISS/pulls/18/reviews");
    return {
      stdout: JSON.stringify(list.map((r) => ({ user: { login: r.user }, state: r.state, submitted_at: "2026-09-06T12:00:00Z" }))),
      stderr: "",
    };
  });
}

describe("getLatestReview", () => {
  it("returns the latest submission of any state (COMMENTED included, issue #407)", async () => {
    const gh = reviewsGh([{ user: "a", state: "APPROVED" }, { user: "b", state: "COMMENTED" }]);
    await expect(getLatestReview(gh, REPO, 18)).resolves.toEqual({
      state: "COMMENTED",
      author: "b",
      submittedAt: "2026-09-06T12:00:00Z",
    });
  });

  it("skips PENDING and DISMISSED submissions", async () => {
    const gh = reviewsGh([{ user: "a", state: "PENDING" }, { user: "b", state: "DISMISSED" }]);
    await expect(getLatestReview(gh, REPO, 18)).resolves.toBeNull();
  });

  it("null without reviews", async () => {
    const gh = reviewsGh([]);
    await expect(getLatestReview(gh, REPO, 18)).resolves.toBeNull();
  });
});