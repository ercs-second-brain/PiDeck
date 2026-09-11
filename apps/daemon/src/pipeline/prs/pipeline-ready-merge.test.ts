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
  h.sessions.control.listWorkers()[0]!.prNumbers = [12];
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

  it("a busy author (running status) does not hold the approval-recorded notification", async () => {
    // Issue #503: the approval action drives the notification — the author's
    // agent-reported `running` status holds only the idle-gated backstop
    // (rounds without a newly recorded approval, e.g. the third test here).
    const h = greenHarness({ reviewAccount: () => false }); // single-account mode, human approval
    await h.poll();
    approve(h, "2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    h.sessions.control.listWorkers()[0]!.status = "running";
    const seen: PRPipelineEvent[] = [...(await h.poll())];
    expect(readyEvents(seen)).toHaveLength(1);

    // Still exactly once per round: back to idle, the backstop cannot re-fire.
    h.sessions.control.listWorkers()[0]!.status = "awaiting_ci";
    seen.push(...(await h.poll()));
    expect(readyEvents(seen)).toHaveLength(1);
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

describe("PullRequestPipeline: approval-recorded trigger (issue #503)", () => {
  // Issue #503: the approval-recorded leg. The approval action itself
  // notifies — even when the idle gates would hold the backstop (the author
  // parked on an agent-reported `running` status, the reviewer's pane still
  // live) — exactly once per approval round.
  it("the reviewer's approval notifies on the poll that records it, even while the author is busy", async () => {
    // The author sits on an agent-reported `running` status (the pipeline
    // cannot see typing) — the idle-gated backstop would hold forever.
    const h = greenHarness();
    await h.poll(); // discover + track
    await h.poll(); // reviewer spawns
    h.sessions.control.listWorkers()[0]!.status = "running";
    approve(h, "2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    const events = await h.poll();
    expect(readyEvents(events)).toHaveLength(1);
    expect(h.tracker.get(PROJECT, 12)!.readyNotifiedHeadSha).toBe("sha-1");

    // Still exactly once per round: the backstop cannot re-fire behind the
    // approval leg's watermark, whatever the author's status does next.
    h.sessions.control.listWorkers()[0]!.status = "awaiting_ci";
    await h.poll();
    expect(readyEvents(events)).toHaveLength(1);
  });

  it("a newly recorded approval and the idle-gated backstop notify once per round together", async () => {
    // Everything idle on the approval poll: both legs run on the same poll
    // — the approval leg marks the watermark, the backstop skips.
    const h = greenHarness();
    await h.poll();
    approve(h, "2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    const events = await h.poll();
    expect(readyEvents(events)).toHaveLength(1);
  });

  it("a COMMENTED review does not drive the approval leg (not an approval action)", async () => {
    // The author sits busy (`running`): the idle-gated backstop is held, so
    // any new event would have to come from the approval leg — which must
    // not fire for a COMMENT submission even on an approved PR.
    const h = greenHarness({ reviewAccount: () => false });
    await h.poll();
    h.sessions.control.listWorkers()[0]!.status = "running";
    approve(h, "2026-09-06T12:05:00Z");
    h.advance(5 * 60_000);
    const seen: PRPipelineEvent[] = [...(await h.poll())];
    expect(readyEvents(seen)).toHaveLength(1);

    h.prs.get(12)!.reviews = [
      { user: { login: "alice" }, state: "APPROVED", submitted_at: "2026-09-06T12:05:00Z" },
      { user: { login: "alice" }, state: "COMMENTED", submitted_at: "2026-09-06T12:10:00Z" },
    ];
    h.advance(5 * 60_000);
    seen.push(...(await h.poll()));
    expect(readyEvents(seen)).toHaveLength(1);
  });
});
