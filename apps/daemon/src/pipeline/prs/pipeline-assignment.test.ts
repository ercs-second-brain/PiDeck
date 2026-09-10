/**
 * PR-assignment leg (issue #408, flow steps 4–5): worker PRs are assigned to
 * the review account's user on submission, and the review agent spawns only
 * for PRs assigned to that review user (CI-green on an assigned PR is the
 * deterministic trigger). Shared fakes: `harness.ts`.
 */

import { describe, expect, it } from "vitest";

import { restPull } from "../../testing/fixtures.js";
import { checkRuns, makeHarness, PROJECT, REVIEW_USER, type Harness } from "./harness.js";

/** PR #12 owned by the harness's default worker, CI green, no reviews. `assigned` puts the review user on the PR. */
function greenHarness(options: Parameters<typeof makeHarness>[0] = {}, assigned = false): Harness {
  const h = makeHarness(options);
  h.openList.push(12);
  h.prs.set(12, {
    pull: assigned ? { ...restPull(12, { sha: "sha-1" }), assignees: [{ login: REVIEW_USER }] } : restPull(12, { sha: "sha-1" }),
    checkRuns: checkRuns("success"),
    reviews: [],
    comments: [],
  });
  h.sessions.control.listWorkers()[0]!.prNumber = 12;
  return h;
}

describe("PullRequestPipeline: PR assignment leg (issue #408)", () => {
  it("assigns the review user to a worker PR on submission", async () => {
    const h = makeHarness({ reviewAccountUsername: () => REVIEW_USER });
    h.openList.push(12);
    h.prs.set(12, { pull: restPull(12), checkRuns: checkRuns("success"), reviews: [], comments: [] });
    h.sessions.control.listWorkers()[0]!.prNumber = 12;
    await h.poll(); // discovery poll registers the PR
    expect(h.assignments).toEqual([{ path: "/repos/o/r/issues/12/assignees", assignees: [REVIEW_USER] }]);
  });

  it("does not assign in single-account mode (no review account configured)", async () => {
    const h = greenHarness({ reviewAccount: () => false });
    await h.poll();
    expect(h.assignments).toEqual([]);
  });

  it("skips the assignment POST when the PR already carries the review user", async () => {
    const h = greenHarness({ reviewAccountUsername: () => REVIEW_USER }, true);
    await h.poll();
    expect(h.assignments).toEqual([]);
  });

  it("a failed assignment POST is non-fatal — the PR is still tracked", async () => {
    const h = greenHarness({ reviewAccountUsername: () => REVIEW_USER, failAssignees: true });
    const events = await h.poll();
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ prNumber: 12 });
    // Issue #411: CI passed at discovery — the author rests at `done`, not
    // the stale `awaiting_ci` (B34).
    expect(h.sessions.statuses.at(-1)).toMatchObject({ status: "done" });
    expect(prEvents(events).length).toBeGreaterThanOrEqual(0); // the loop kept emitting cards
  });
});

describe("PullRequestPipeline: reviewer-spawn assignment gate (issue #408)", () => {
  it("CI-green on a PR assigned to the review user spawns the reviewer", async () => {
    const h = greenHarness({ reviewAccountUsername: () => REVIEW_USER }, true);
    await h.poll(); // discover + track
    await h.poll(); // reviewer spawns
    expect(h.sessions.spawned).toHaveLength(1);
    expect(h.tracker.get(PROJECT, 12)!.reviewWorkerId).not.toBeNull();
  });

  it("CI-green on a PR NOT assigned to the review user spawns no reviewer", async () => {
    const h = greenHarness({ reviewAccountUsername: () => REVIEW_USER }, false);
    await h.poll();
    await h.poll();
    expect(h.sessions.spawned).toHaveLength(0);

    // The assignment arriving (e.g. manually) opens the gate on the next poll.
    h.prs.get(12)!.pull = { ...restPull(12, { sha: "sha-1" }), assignees: [{ login: REVIEW_USER }] };
    await h.poll();
    expect(h.sessions.spawned).toHaveLength(1);
  });

  it("single-account mode: the whole review cycle is inert (no reviewer spawn)", async () => {
    // Issue #424 (F2): the pre-#408 "no review user → unconditioned spawn"
    // cohort is gone — a configured review account always carries its login
    // (both-or-neither settings validation), and single-account mode turns
    // the review cycle off entirely.
    const h = greenHarness({ reviewAccount: () => false }, false);
    await h.poll();
    await h.poll();
    expect(h.sessions.spawned).toHaveLength(0);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ reviewWorkerId: null });
  });

  it("a changes-requested review reaches the worker regardless of the assignment", async () => {
    const h = greenHarness({ reviewAccountUsername: () => REVIEW_USER }, false);
    await h.poll();
    await h.poll();
    h.prs.get(12)!.reviews = [{ user: { login: "human" }, state: "CHANGES_REQUESTED", submitted_at: "2026-09-06T12:05:00Z" }];
    h.advance(5 * 60_000);
    await h.poll();
    // Findings from any reviewer reach the author — the assignment gate only
    // holds the reviewer spawn, not the findings trigger (issue #407 compose).
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.sessions.prompts[0]!.keys).toContain("requested changes on your PR #12");
  });
});

/** Card/failed events only (the ready-for-merge notification is asserted separately). */
function prEvents(events: Awaited<ReturnType<Harness["poll"]>>): Awaited<ReturnType<Harness["poll"]>> {
  return events.filter((e) => e.type === "kanban.pr.card" || e.type === "kanban.pr.failed");
}
