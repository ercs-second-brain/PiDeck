/**
 * PR-pipeline review-trigger tests (issue #407): with a review account
 * configured, a completed GitHub review round deterministically wakes the
 * PR-authoring worker to address the findings — even when the findings ride
 * only in the review body (no inline comments). Without the review account,
 * the whole review cycle (agent spawn + triggers) is off. Shared fakes:
 * `harness.ts`.
 */

import { describe, expect, it } from "vitest";

import { restPull } from "../../testing/fixtures.js";
import { checkRuns, makeHarness, PROJECT, restComment, REVIEW_USER, type Harness } from "./harness.js";

/** Tracks PR #12 owned by the harness's default worker, CI green, no reviews. */
function greenHarness(options: Parameters<typeof makeHarness>[0] = {}): Harness {
  const h = makeHarness(options);
  h.openList.push(12);
  h.prs.set(12, { pull: assignedPull(), checkRuns: checkRuns("success"), reviews: [], comments: [] });
  h.sessions.control.listWorkers()[0]!.prNumber = 12;
  return h;
}

/** A pull payload assigned to the review user — the configured-mode spawn gate (issue #408/#424). */
function assignedPull(overrides: Parameters<typeof restPull>[1] = {}): Record<string, unknown> {
  return { ...restPull(12, overrides), assignees: [{ login: REVIEW_USER }] };
}

const CHANGES_REQUESTED = (submittedAt: string) => [{ user: { login: "reviewer" }, state: "CHANGES_REQUESTED", submitted_at: submittedAt }];

describe("PullRequestPipeline: review-trigger (issue #407)", () => {
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
    expect(h.sessions.prompts[0]!.keys).toContain("review-comments skill");
  });

  it("a review landing alongside its inline comments is delivered once (comments branch wins)", async () => {
    const h = greenHarness();
    await h.poll();
    await h.poll();
    h.prs.get(12)!.comments = [restComment(101, "Rename this variable")];
    h.prs.get(12)!.reviews = CHANGES_REQUESTED("2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    await h.poll();
    // The inline-comment delivery branch owns the author's prompt state.
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.sessions.prompts[0]!.keys).toContain("1 new review comment(s)");
    // The review is recorded (observed) — it never re-fires later.
    expect(h.tracker.get(PROJECT, 12)!.lastReviewSeenAt).toBe("2026-09-06T12:05:00Z");
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
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
  });

  it("a pre-existing review (loop start / restart resume) is recorded without triggering", async () => {
    const h = greenHarness();
    h.prs.set(12, {
      pull: assignedPull(),
      checkRuns: checkRuns("success"),
      reviews: CHANGES_REQUESTED("2026-09-06T11:00:00Z"),
      comments: [],
    });
    h.sessions.control.listWorkers()[0]!.prNumber = 12;
    await h.poll();
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(0);
    expect(h.tracker.get(PROJECT, 12)!.lastReviewSeenAt).toBe("2026-09-06T11:00:00Z");
  });

  it("an approval is not a findings trigger", async () => {
    const h = greenHarness();
    await h.poll();
    await h.poll();
    h.prs.get(12)!.reviews = [{ user: { login: "reviewer" }, state: "APPROVED", submitted_at: "2026-09-06T12:05:00Z" }];
    h.advance(5 * 60_000);
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(0);
    // The reviewer is archived; the cycle ends.
    expect(h.sessions.archived).toEqual(["worker-reviewer-1"]);
  });
});

describe("PullRequestPipeline: review-trigger — gating (issue #407)", () => {
  it("single-account mode: no reviewer spawns and review events trigger nothing", async () => {
    const h = greenHarness({ reviewAccount: () => false });
    await h.poll();
    await h.poll();
    expect(h.sessions.spawned).toHaveLength(0);

    h.prs.get(12)!.reviews = CHANGES_REQUESTED("2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(0);
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("watching");
  });

  it("autoFixReviewComments off: the trigger is skipped, the review still recorded", async () => {
    const h = greenHarness({
      workerSettings: () => ({ terminateOnMerge: true, autoFixCi: true, autoFixReviewComments: false, autoReview: true }),
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
    });
  });

  it("a review landing during a red CI streak is recorded once and left to the re-review round", async () => {
    const h = greenHarness();
    await h.poll(); // track
    h.prs.get(12)!.checkRuns = checkRuns("failure");
    await h.poll(); // CI-fix prompt; review arrives while red
    h.prs.get(12)!.reviews = CHANGES_REQUESTED("2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    await h.poll();
    // Recorded deterministically (once per submission), but the red branch
    // owns the author's prompt (the CI-fix prompt carries inline comments);
    // review-body findings reach the author via the reviewer's next round.
    expect(h.tracker.get(PROJECT, 12)!.lastReviewSeenAt).toBe("2026-09-06T12:05:00Z");
    h.prs.get(12)!.checkRuns = checkRuns("success");
    await h.poll();
    expect(h.sessions.prompts.some((p) => p.keys.includes("requested changes"))).toBe(false);
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