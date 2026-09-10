/**
 * Ready-for-merge trigger (issue #408): when a tracked PR is CI-green,
 * approved, and both the author worker and the reviewer are idle, the
 * pipeline emits `notification.pr.ready_for_merge` — exactly once per round
 * (per head; a fresh review round re-arms it). Works in both modes: a human
 * approval in single-account mode is just as ready as the auto reviewer's.
 * Shared fakes: `harness.ts`.
 */

import { describe, expect, it } from "vitest";

import { restPull } from "../../testing/fixtures.js";
import type { PRPipelineEvent } from "./events.js";
import { checkRuns, makeHarness, PROJECT, restComment, REVIEW_USER, type Harness } from "./harness.js";

/** PR #12 owned by the harness's default worker, CI green, no reviews. */
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

/** Approves PR #12 with a fresh submission timestamp (as the review identity — configured mode). */
function approve(h: Harness, submittedAt: string): void {
  h.prs.get(12)!.reviews = [{ user: { login: REVIEW_USER }, state: "APPROVED", submitted_at: submittedAt }];
}

function readyEvents(events: PRPipelineEvent[]): PRPipelineEvent[] {
  return events.filter((e) => e.type === "notification.pr.ready_for_merge");
}

describe("PullRequestPipeline: ready-for-merge trigger (issue #408)", () => {
  it("green + approved + idle → the orchestrator is notified exactly once", async () => {
    const h = greenHarness({ reviewAccount: () => false }); // single-account mode, human approval
    await h.poll(); // discover + track
    approve(h, "2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    const events = await h.poll();
    expect(readyEvents(events)).toHaveLength(1);
    expect(readyEvents(events)[0]).toMatchObject({ prNumber: 12 });
    expect(h.tracker.get(PROJECT, 12)!.readyNotifiedHeadSha).toBe("sha-1");

    // Same round again → no duplicate.
    await h.poll();
    expect(readyEvents(events)).toHaveLength(1);
  });

  it("fires while the author sits in awaiting_ci and the reviewer is archived", async () => {
    // Full auto cycle: reviewer spawns, approves, is archived, then the
    // ready notification rides the same poll as the archival.
    const h = greenHarness();
    await h.poll(); // discover + track
    await h.poll(); // reviewer spawns
    const reviewerId = h.tracker.get(PROJECT, 12)!.reviewWorkerId;
    expect(reviewerId).not.toBeNull();
    approve(h, "2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    const events = await h.poll();
    expect(h.sessions.archived).toContain(reviewerId);
    expect(readyEvents(events)).toHaveLength(1);
  });

  it("does not fire while CI is red or the author is mid-prompt (addressing)", async () => {
    const h = greenHarness();
    await h.poll();
    await h.poll(); // reviewer spawned
    // Red CI: not ready, whatever the review says. The fix prompt delivers
    // the pending comment with it (comments are marked seen).
    h.prs.get(12)!.checkRuns = checkRuns("failure");
    h.prs.get(12)!.comments = [restComment(101, "Rename this")];
    approve(h, "2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    await h.poll();
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("fixing");
    expect(readyEvents(h.emit)).toHaveLength(0);

    // Green again + approved, but the author is still mid-fix — the state
    // machine owns the author's attention.
    h.prs.get(12)!.checkRuns = checkRuns("success");
    h.advance(5 * 60_000);
    await h.poll();
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("fixing");
    expect(readyEvents(h.emit)).toHaveLength(0);

    // Prompt goes stale → watching again → the (still approved, green) PR notifies.
    h.advance(20 * 60_000);
    const events = await h.poll();
    expect(readyEvents(events)).toHaveLength(1);
  });

  it("a busy author (running status) holds the notification", async () => {
    const h = greenHarness({ reviewAccount: () => false });
    await h.poll();
    approve(h, "2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    h.sessions.control.listWorkers()[0]!.status = "running";
    await h.poll();
    expect(readyEvents(h.emit)).toHaveLength(0);

    // Back to idle → notifies on the next poll.
    h.sessions.control.listWorkers()[0]!.status = "awaiting_ci";
    const events = await h.poll();
    expect(readyEvents(events)).toHaveLength(1);
  });

  it("a new review round re-arms the trigger even on an unchanged head", async () => {
    // Auto mode: the reviewer exists, so the changes-requested round flows
    // through the #407 findings trigger before the fresh approval.
    const h = greenHarness();
    await h.poll();
    approve(h, "2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    let events = await h.poll();
    expect(readyEvents(events)).toHaveLength(1);

    // Changes requested (new submission) → addressed without a push (the
    // head never moves), then a fresh approval on the same head.
    h.prs.get(12)!.reviews = [{ user: { login: "reviewer" }, state: "CHANGES_REQUESTED", submitted_at: "2026-09-06T12:10:00Z" }];
    h.advance(5 * 60_000);
    await h.poll(); // author prompted (addressing)
    expect(h.sessions.prompts).toHaveLength(1);
    h.advance(20 * 60_000); // prompt stale → watching again
    approve(h, "2026-09-06T12:40:00Z");
    events = await h.poll();
    expect(readyEvents(events)).toHaveLength(1); // the second round notifies again
    expect(h.tracker.get(PROJECT, 12)!.readyNotifiedHeadSha).toBe("sha-1");
  });
});
