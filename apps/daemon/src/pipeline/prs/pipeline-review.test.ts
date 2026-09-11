/**
 * PR-pipeline review-comment tests: delivery to the owning worker and the
 * `autoFixReviewComments` gate (issue #106). Shared fakes: `harness.ts`.
 */

import { describe, expect, it } from "vitest";

import { restPull } from "../../testing/fixtures.js";
import { checkRuns, makeHarness, PROJECT, restComment } from "./harness.js";

describe("PullRequestPipeline: review comments", () => {
  it("delivers review comments to the worker and handles comments arriving after fixes", async () => {
    // autoReview off: the review-comment delivery flow (#106) is orthogonal
    // to the review-agent cycle (#107, pipeline-review-agent.test.ts).
    const h = makeHarness({ workerSettings: () => ({ terminateOnMerge: true, autoFixCi: true, autoFixReviewComments: true, autoReview: false, workerReuseContextThreshold: 20 }) });
    h.openList.push(12);
    h.prs.set(12, {
      pull: restPull(12, { sha: "sha-1" }),
      checkRuns: checkRuns("success"),
      reviews: [],
      comments: [],
    });
    h.sessions.control.listWorkers()[0]!.prNumbers = [12];
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
});
