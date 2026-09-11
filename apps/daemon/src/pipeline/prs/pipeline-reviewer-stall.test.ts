/**
 * The reviewer round's stall backstop and review-identity attribution
 * (issue #501, B9): a reviewer whose round ends WITHOUT an attributable
 * GitHub review submission must not show `running` forever — the sidebar
 * has to reflect the agent's real state.
 *
 * Split from pipeline-status-truth.test.ts (issue #411) to keep each
 * describe within the repo's function-size budget.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_STALL_IDLE_MS } from "../issues/stall-sweep.js";
import { restPull } from "../../testing/fixtures.js";
import { checkRuns, makeHarness, PROJECT, REVIEW_USER, type Harness } from "./harness.js";

/** PR #12 owned by the harness's default worker, CI green, assigned, no reviews. */
function greenHarness(options: Parameters<typeof makeHarness>[0] = {}): Harness {
  const h = makeHarness(options);
  h.openList.push(12);
  h.prs.set(12, { pull: { ...restPull(12), assignees: [{ login: REVIEW_USER }] }, checkRuns: checkRuns("success"), reviews: [], comments: [] });
  h.sessions.control.listWorkers()[0]!.prNumbers = [12];
  return h;
}

/** Status changes recorded for one worker id. */
function statusesFor(h: Harness, workerId: string): Array<{ status: string; statusMessage?: string | null }> {
  return h.sessions.statuses.filter((s) => s.workerId === workerId);
}

describe("PullRequestPipeline: reviewer round stall backstop + attribution (issue #501)", () => {
  // Issue #501 (B9): a round that ends WITHOUT an attributable review
  // submission must not leave the reviewer `running` forever — the stall
  // backstop rests it (the sweep defers reviewers to this loop, #441).
  it("a round with no review submission rests after the stall window (stall backstop)", async () => {
    const h = greenHarness();
    await h.poll();
    await h.poll();
    const reviewerId = h.tracker.get(PROJECT, 12)!.reviewWorkerId!;
    expect(h.sessions.control.getWorker(reviewerId)).toMatchObject({ status: "running" });

    // Still inside the window: the round is legitimately in flight.
    h.advance(DEFAULT_STALL_IDLE_MS - 60_000);
    await h.poll();
    expect(h.sessions.control.getWorker(reviewerId)).toMatchObject({ status: "running" });

    // Past the window with no submission: the round rests.
    h.advance(2 * 60_000);
    await h.poll();
    expect(h.sessions.control.getWorker(reviewerId)).toMatchObject({
      status: "awaiting_ci",
      statusMessage: expect.stringContaining("stall backstop"),
    });

    // No churn: further polls keep it resting.
    await h.poll();
    expect(statusesFor(h, reviewerId)).toHaveLength(1);
  });

  it("the stall backstop fires on red polls too", async () => {
    const h = greenHarness();
    await h.poll();
    await h.poll();
    const reviewerId = h.tracker.get(PROJECT, 12)!.reviewWorkerId!;
    h.prs.get(12)!.checkRuns = checkRuns("failure");
    h.prs.get(12)!.pull = { ...restPull(12, { sha: "sha-2" }), assignees: [{ login: REVIEW_USER }] };
    h.advance(DEFAULT_STALL_IDLE_MS + 60_000);
    await h.poll();
    expect(h.sessions.control.getWorker(reviewerId)).toMatchObject({
      status: "awaiting_ci",
      statusMessage: expect.stringContaining("stall backstop"),
    });
  });

  it("a submission observed before the window still settles first (backstop idles)", async () => {
    const h = greenHarness();
    await h.poll();
    await h.poll();
    const reviewerId = h.tracker.get(PROJECT, 12)!.reviewWorkerId!;
    h.advance(DEFAULT_STALL_IDLE_MS - 60_000);
    h.prs.get(12)!.reviews = [{ user: { login: REVIEW_USER }, state: "CHANGES_REQUESTED", submitted_at: "2026-09-06T12:13:00Z" }];
    await h.poll();
    expect(statusesFor(h, reviewerId).at(-1)).toMatchObject({
      status: "awaiting_ci",
      statusMessage: "PR #12: review posted — awaiting author changes",
    });
    // The round-end settle, not the backstop — even with the clock now past
    // the window, the next poll must not rewrite the resting reviewer.
    h.advance(2 * 60_000);
    await h.poll();
    expect(statusesFor(h, reviewerId)).toHaveLength(1);
  });

  it("attribution is case-insensitive end to end (spawn gate + settle, issue #501)", async () => {
    // Settings keep the user-typed casing; GitHub canonicalizes logins.
    const h = greenHarness({ reviewAccountUsername: () => "Review-Bot" });
    h.prs.get(12)!.pull = { ...restPull(12), assignees: [{ login: "review-bot" }] };
    await h.poll();
    await h.poll();
    const reviewerId = h.tracker.get(PROJECT, 12)!.reviewWorkerId!;
    expect(reviewerId).not.toBeNull(); // the mis-cased assignee still passes the spawn gate

    h.prs.get(12)!.reviews = [{ user: { login: "review-bot" }, state: "CHANGES_REQUESTED", submitted_at: "2026-09-06T12:05:00Z" }];
    await h.poll();
    expect(h.sessions.control.getWorker(reviewerId)).toMatchObject({ status: "awaiting_ci" });
  });
});
