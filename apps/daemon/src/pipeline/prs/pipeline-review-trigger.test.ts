/**
 * PR-pipeline review-trigger tests (issues #407/#440): a completed GitHub
 * review round that requests changes deterministically wakes the
 * PR-authoring worker to address the findings — even when the findings ride
 * only in the review body (no inline comments) — with a bounded fix cycle
 * like the CI-fix one (#440). Shared fakes: `harness.ts`.
 */

import { describe, expect, it } from "vitest";

import { restPull } from "../../testing/fixtures.js";
import { checkRuns, makeHarness, PROJECT, restComment, REVIEW_USER, type Harness } from "./harness.js";

/** Tracks PR #12 owned by the harness's default worker, CI green, no reviews. */
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

const CHANGES_REQUESTED = (submittedAt: string) => [{ user: { login: "reviewer" }, state: "CHANGES_REQUESTED", submitted_at: submittedAt }];

describe("PullRequestPipeline: review-trigger delivery (issues #407/#440)", () => {
  it("a new request-changes review prompts the author once to address the findings", async () => {
    const h = greenHarness();
    await h.poll(); // discover + track
    await h.poll(); // reviewer spawns

    h.prs.get(12)!.reviews = CHANGES_REQUESTED("2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.sessions.prompts[0]).toEqual({
      sessionId: "sess-1",
      keys: expect.stringContaining("requested changes on your PR #12"),
    });
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({
      state: "addressing",
      lastPromptedHeadSha: "sha-1",
      lastReviewSeenAt: "2026-09-06T12:05:00Z",
      pendingReviewDecision: false,
      reviewFixAttempts: 1,
    });
    expect(h.sessions.statuses.at(-1)).toMatchObject({ workerId: "worker-1", status: "addressing_review" });

    // Same review again → no duplicate prompt.
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
  });

  it("triggers on a review whose findings ride only in the review body (no inline comments)", async () => {
    const h = greenHarness();
    await h.poll();
    await h.poll();
    h.prs.get(12)!.reviews = CHANGES_REQUESTED("2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.sessions.prompts[0]!.keys).toContain("Fetch the findings");
  });

  it("a review landing alongside its inline comments still prompts the decision round after the comment round (issue #440)", async () => {
    const h = greenHarness();
    await h.poll();
    await h.poll();
    h.prs.get(12)!.comments = [restComment(101, "Rename this variable")];
    h.prs.get(12)!.reviews = CHANGES_REQUESTED("2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    await h.poll();
    // The inline-comment delivery branch owns the author's first prompt.
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.sessions.prompts[0]!.keys).toContain("1 new review comment(s)");
    // The review is recorded (observed) and its decision stays pending.
    expect(h.tracker.get(PROJECT, 12)!.lastReviewSeenAt).toBe("2026-09-06T12:05:00Z");
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1); // the comment prompt is in flight

    // The author pushes → watching again → the parked decision delivers its
    // own bounded fix round; the reviewer's re-review prompt rides the same
    // poll (decision branch first, then the reviewer cycle).
    h.prs.get(12)!.pull = assignedPull({ sha: "sha-2" });
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(3);
    expect(h.sessions.prompts[1]!.sessionId).toBe("sess-1");
    expect(h.sessions.prompts[1]!.keys).toContain("requested changes on your PR #12");
    expect(h.sessions.prompts[2]!.sessionId).toBe("sess-reviewer-1");
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ state: "addressing", reviewFixAttempts: 1, pendingReviewDecision: false });
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(3); // no duplicates
  });

  it("each review round triggers exactly once — a fresh round re-prompts", async () => {
    const h = greenHarness();
    await h.poll();
    await h.poll();
    h.prs.get(12)!.reviews = CHANGES_REQUESTED("2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);

    // Author pushes; the reviewer is re-prompted for the new head.
    h.prs.get(12)!.pull = assignedPull({ sha: "sha-2" });
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(2);
    expect(h.sessions.prompts[1]!.sessionId).toBe("sess-reviewer-1");

    // The reviewer's fresh round requests changes again → the author is
    // triggered for the new submission, not a replay of the old one.
    h.prs.get(12)!.reviews = [...CHANGES_REQUESTED("2026-09-06T12:05:00Z"), CHANGES_REQUESTED("2026-09-06T12:10:00Z")[0]!];
    h.advance(5 * 60_000);
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(3);
    expect(h.tracker.get(PROJECT, 12)!.lastReviewSeenAt).toBe("2026-09-06T12:10:00Z");
    expect(h.tracker.get(PROJECT, 12)!.reviewFixAttempts).toBe(2);
  });
});

describe("PullRequestPipeline: review-trigger — watermark semantics", () => {
  it("a pre-existing review (loop start / restart resume) is recorded without triggering", async () => {
    const h = greenHarness();
    h.prs.set(12, {
      pull: assignedPull(),
      checkRuns: checkRuns("success"),
      reviews: CHANGES_REQUESTED("2026-09-06T11:00:00Z"),
      comments: [],
    });
    h.sessions.control.listWorkers()[0]!.prNumbers = [12];
    await h.poll();
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(0);
    expect(h.tracker.get(PROJECT, 12)!.lastReviewSeenAt).toBe("2026-09-06T11:00:00Z");
    expect(h.tracker.get(PROJECT, 12)!.pendingReviewDecision).toBe(false);
  });

  it("an approval is not a findings trigger and resets the decision bound", async () => {
    const h = greenHarness();
    await h.poll();
    await h.poll();
    h.prs.get(12)!.reviews = [{ user: { login: "reviewer" }, state: "APPROVED", submitted_at: "2026-09-06T12:05:00Z" }];
    h.advance(5 * 60_000);
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(0);
    // The reviewer is archived; the cycle ends.
    expect(h.sessions.archived).toEqual(["worker-reviewer-1"]);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ pendingReviewDecision: false, reviewFixAttempts: 0 });
  });
});

describe("PullRequestPipeline: review-trigger — bounded fix cycle (issue #440)", () => {
  it("a decision observed mid-prompt is parked and delivered once the author is idle again", async () => {
    // The regression from the report: a review decision consumed while the
    // author is still working (state !== watching) used to be lost — the
    // loop stalled. The parked decision must deliver afterwards.
    const h = greenHarness();
    await h.poll();
    await h.poll();
    // The reviewer requests changes while the author is addressing earlier
    // review comments (a prompt is in flight).
    h.prs.get(12)!.comments = [restComment(101, "Rename this variable")];
    h.advance(5 * 60_000);
    await h.poll();
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("addressing");
    h.prs.get(12)!.reviews = CHANGES_REQUESTED("2026-09-06T12:06:00Z");
    await h.poll();
    // Consumed mid-prompt: no prompt now, but the decision is parked.
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({
      state: "addressing",
      pendingReviewDecision: true,
      reviewFixAttempts: 0,
    });

    // The author pushes → watching → the parked decision delivers its
    // bounded fix round (the reviewer's re-review prompt rides the same poll).
    h.prs.get(12)!.pull = assignedPull({ sha: "sha-2" });
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(3);
    expect(h.sessions.prompts[1]!.sessionId).toBe("sess-1");
    expect(h.sessions.prompts[1]!.keys).toContain("requested changes on your PR #12");
    expect(h.sessions.prompts[2]!.sessionId).toBe("sess-reviewer-1");
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ state: "addressing", reviewFixAttempts: 1, pendingReviewDecision: false });
  });

  it("a delivered decision prompt that goes stale without a push re-prompts (bounded)", async () => {
    const h = greenHarness({ fixPromptTimeoutMs: 1000 });
    await h.poll();
    await h.poll();
    h.prs.get(12)!.reviews = CHANGES_REQUESTED("2026-09-06T12:05:00Z");
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);

    // The author never pushes; the prompt goes stale → the standing
    // decision re-prompts instead of stalling.
    h.advance(2000);
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(2);
    expect(h.sessions.prompts[1]!.keys).toContain("Fix round 2 of 5");
    expect(h.tracker.get(PROJECT, 12)!.reviewFixAttempts).toBe(2);
  });

  it("decision-round exhaustion is terminal like the CI bound (issue #440)", async () => {
    const h = greenHarness({ maxFixAttempts: 2, fixPromptTimeoutMs: 1000 });
    await h.poll();
    await h.poll();
    h.prs.get(12)!.reviews = CHANGES_REQUESTED("2026-09-06T12:05:00Z");
    await h.poll(); // round 1
    h.advance(2000);
    await h.poll(); // stale → round 2
    expect(h.tracker.get(PROJECT, 12)!.reviewFixAttempts).toBe(2);
    h.advance(2000);
    const events = await h.poll(); // stale again → bound exhausted
    expect(h.sessions.prompts).toHaveLength(2); // no third prompt
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("failed");
    expect(h.sessions.statuses.at(-1)).toMatchObject({ workerId: "worker-1", status: "failed" });
    expect(events.filter((e) => e.type === "kanban.pr.failed")).toHaveLength(1);
    expect(JSON.stringify(events)).toContain("review_fix_attempt_limit_exhausted");
  });
});

describe("PullRequestPipeline: review-trigger — gating (issues #407/#440)", () => {
  it("single-account mode: no reviewer spawns, but a human's changes-requested decision still reaches the worker (issue #440)", async () => {
    const h = greenHarness({ reviewAccount: () => false });
    await h.poll();
    await h.poll();
    expect(h.sessions.spawned).toHaveLength(0);

    h.prs.get(12)!.reviews = CHANGES_REQUESTED("2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    await h.poll();
    // Issue #440: the decision branch is account-independent — findings
    // from any reviewer (auto agent, human) must reach the worker.
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.sessions.prompts[0]!.keys).toContain("requested changes on your PR #12");
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ state: "addressing", reviewFixAttempts: 1 });
  });

  it("autoFixReviewComments off: the trigger is skipped, the parked decision survives", async () => {
    const h = greenHarness({
      workerSettings: () => ({ terminateOnMerge: true, autoFixCi: true, autoFixReviewComments: false, autoReview: true, workerReuseContextThreshold: 20 }),
    });
    await h.poll();
    await h.poll();
    h.prs.get(12)!.reviews = CHANGES_REQUESTED("2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(0);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({
      state: "watching",
      lastReviewSeenAt: "2026-09-06T12:05:00Z",
      pendingReviewDecision: true,
    });
    // The gated notice is the truthful status — not flipped back to done.
    expect(h.sessions.statuses.at(-1)).toMatchObject({
      status: "awaiting_ci",
      statusMessage: expect.stringContaining("review requested changes — auto-fix review comments disabled"),
    });
  });

  it("a review landing during a red CI streak is parked and delivers once the fix lands (issue #440)", async () => {
    const h = greenHarness();
    await h.poll(); // track
    h.prs.get(12)!.checkRuns = checkRuns("failure");
    await h.poll(); // CI-fix prompt; review arrives while red
    h.prs.get(12)!.reviews = CHANGES_REQUESTED("2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    await h.poll();
    // Recorded deterministically (the watermark consumes once) and parked —
    // the red branch owns the author's prompt while CI is red.
    expect(h.tracker.get(PROJECT, 12)!.lastReviewSeenAt).toBe("2026-09-06T12:05:00Z");
    expect(h.tracker.get(PROJECT, 12)!.pendingReviewDecision).toBe(true);
    expect(h.sessions.prompts.some((p) => p.keys.includes("requested changes"))).toBe(false);

    // The author's CI fix lands → green → the parked decision delivers its
    // bounded fix round instead of being lost (the B6 stall, issue #440).
    h.prs.get(12)!.pull = assignedPull({ sha: "sha-2" });
    h.prs.get(12)!.checkRuns = checkRuns("success");
    await h.poll();
    expect(h.sessions.prompts.some((p) => p.sessionId === "sess-1" && p.keys.includes("requested changes"))).toBe(true);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ state: "addressing", pendingReviewDecision: false, reviewFixAttempts: 1 });
  });

  it("delivers inline review comments unchanged alongside the trigger path", async () => {
    const h = greenHarness();
    await h.poll();
    h.prs.get(12)!.comments = [restComment(101, "Rename this variable")];
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.sessions.prompts[0]!.keys).toContain("Rename this variable");
  });
});