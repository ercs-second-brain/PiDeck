/**
 * Deterministic worker/reviewer status transitions (issue #411, B34/B35):
 * statuses derive from platform-truth events, not agent self-reports.
 *
 * - B34: a worker whose CI has passed must not remain `awaiting_ci` — CI
 *   completion moves the passively watching author to `done` (resting), and
 *   later platform events (red CI, review findings) wake it deterministically.
 * - B35: a finished reviewer must not show `running` — its own review
 *   submission (#418 watermark) ends the round; a re-review prompt delivery
 *   starts the next one.
 *
 * Shared fakes/harness: `harness.ts`.
 */

import { describe, expect, it } from "vitest";

import { restPull } from "../../testing/fixtures.js";
import { checkRuns, makeHarness, PROJECT, restComment, REVIEW_USER, type Harness } from "./harness.js";

/** PR #12 owned by the harness's default worker, CI green, no reviews. */
function greenHarness(options: Parameters<typeof makeHarness>[0] = {}): Harness {
  const h = makeHarness(options);
  h.openList.push(12);
  h.prs.set(12, { pull: assignedPull(), checkRuns: checkRuns("success"), reviews: [], comments: [] });
  h.sessions.control.listWorkers()[0]!.prNumbers = [12];
  return h;
}

/** A pull payload assigned to the review user — the configured-mode spawn gate (issue #408/#424). */
function assignedPull(overrides: Parameters<typeof restPull>[1] = {}): Record<string, unknown> {
  return { ...restPull(12, overrides), assignees: [{ login: REVIEW_USER }] };
}

/** Status changes recorded for one worker id. */
function statusesFor(h: Harness, workerId: string): Array<{ status: string; statusMessage?: string | null }> {
  return h.sessions.statuses.filter((s) => s.workerId === workerId);
}

describe("PullRequestPipeline: deterministic author statuses (issue #411, B34)", () => {
  it("CI passing moves the watching author out of awaiting_ci to done", async () => {
    const h = greenHarness({ reviewAccount: () => false }); // worker + CI only
    await h.poll(); // discover + track

    const changes = statusesFor(h, "worker-1");
    expect(changes.at(-2)).toMatchObject({ status: "awaiting_ci" }); // PR discovery
    expect(changes.at(-1)).toMatchObject({
      status: "done",
      statusMessage: "PR #12: CI green — awaiting review/merge",
    });
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("watching");

    // Settled: further polls do not re-broadcast the transition (no churn).
    await h.poll();
    expect(statusesFor(h, "worker-1")).toHaveLength(2);
  });

  it("a done author is woken deterministically when CI goes red again", async () => {
    const h = greenHarness({ reviewAccount: () => false, maxFixAttempts: 3 });
    await h.poll(); // discover + track → author done (CI green)

    // New head, CI red → the fix prompt treats the resting author as active.
    h.prs.get(12)!.pull = restPull(12, { sha: "sha-2" });
    h.prs.get(12)!.checkRuns = checkRuns("failure");
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("fixing");
    expect(statusesFor(h, "worker-1").at(-1)).toMatchObject({ status: "fixing_ci" });
  });

  it("the #106 gated notice is not clobbered by the CI-passed transition (no ping-pong)", async () => {
    const h = greenHarness({
      reviewAccount: () => false,
      workerSettings: () => ({ terminateOnMerge: true, autoFixCi: true, autoFixReviewComments: false, autoReview: false }),
    });
    await h.poll(); // discover + track → author done (green, no comments)

    // Undelivered review comment + auto-fix off → the gated notice is the
    // truthful status and must survive every later poll.
    h.prs.get(12)!.comments = [restComment(101, "Rename this variable")];
    await h.poll();
    expect(statusesFor(h, "worker-1").at(-1)).toMatchObject({
      status: "awaiting_ci",
      statusMessage: expect.stringContaining("auto-fix review comments disabled"),
    });
    await h.poll();
    await h.poll();
    // No churn: the notice is asserted once, then deduped — never flipped
    // back and forth between awaiting_ci and done.
    expect(statusesFor(h, "worker-1")).toHaveLength(3);
  });

});

describe("PullRequestPipeline: deterministic reviewer statuses (issue #411, B35)", () => {
  it("the reviewer's own review submission ends its running round", async () => {
    const h = greenHarness();
    await h.poll(); // discover + track
    await h.poll(); // reviewer spawns (running)
    const reviewerId = h.tracker.get(PROJECT, 12)!.reviewWorkerId!;
    expect(h.sessions.control.getWorker(reviewerId)).toMatchObject({ status: "running" });

    // The reviewer posts a changes-requested review → its round is over.
    // The review author is the configured review identity (issue #424: the
    // settle attribution always keys off reviewAccountUsername).
    h.prs.get(12)!.reviews = [{ user: { login: REVIEW_USER }, state: "CHANGES_REQUESTED", submitted_at: "2026-09-06T12:05:00Z" }];
    await h.poll();
    expect(h.sessions.control.getWorker(reviewerId)).toMatchObject({
      status: "awaiting_ci",
      statusMessage: "PR #12: review posted — awaiting author changes",
    });

    // Resting, not gone: further polls keep it there (no churn).
    await h.poll();
    expect(statusesFor(h, reviewerId)).toHaveLength(1); // only the round-end settle

    // The author pushes → the re-review prompt flips it back to running.
    h.prs.get(12)!.pull = { ...restPull(12, { sha: "sha-2" }), assignees: [{ login: REVIEW_USER }] };
    await h.poll();
    expect(h.sessions.prompts.some((p) => p.sessionId === h.sessions.control.getWorker(reviewerId)!.sessionId)).toBe(true);
    expect(h.sessions.control.getWorker(reviewerId)).toMatchObject({ status: "running", statusMessage: "PR #12: re-review requested" });
  });

  it("attributes the submission to the review user when one is configured", async () => {
    const h = greenHarness({ reviewAccountUsername: () => "reviewer-bot" });
    h.prs.get(12)!.pull = { ...restPull(12, { sha: "sha-1" }), assignees: [{ login: "reviewer-bot" }] };
    await h.poll(); // discover + track
    await h.poll(); // reviewer spawns (assigned to the review user)
    const reviewerId = h.tracker.get(PROJECT, 12)!.reviewWorkerId!;

    // A human's review is not the reviewer's round end.
    h.prs.get(12)!.reviews = [{ user: { login: "alice" }, state: "COMMENTED", submitted_at: "2026-09-06T12:05:00Z" }];
    await h.poll();
    expect(h.sessions.control.getWorker(reviewerId)).toMatchObject({ status: "running" });

    // The reviewer's own submission settles it.
    h.prs.get(12)!.reviews = [{ user: { login: "reviewer-bot" }, state: "CHANGES_REQUESTED", submitted_at: "2026-09-06T12:06:00Z" }];
    await h.poll();
    expect(h.sessions.control.getWorker(reviewerId)).toMatchObject({ status: "awaiting_ci" });
  });

  it("an approval archives the reviewer instead of resting it", async () => {
    const h = greenHarness();
    await h.poll();
    await h.poll();
    const reviewerId = h.tracker.get(PROJECT, 12)!.reviewWorkerId!;
    h.prs.get(12)!.reviews = [{ user: { login: "reviewer-bot" }, state: "APPROVED", submitted_at: "2026-09-06T12:05:00Z" }];
    await h.poll();
    expect(h.sessions.archived).toContain(reviewerId);
    expect(h.sessions.control.getWorker(reviewerId)).toMatchObject({ status: "archived" });
  });
});