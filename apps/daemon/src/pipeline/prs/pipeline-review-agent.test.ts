/**
 * PR-pipeline auto review agent tests (issue #107): spawn on green,
 * re-review on new heads, archive on approval/terminal states, the
 * `autoReview` gate, and the worker-concurrency cap. Shared fakes:
 * `harness.ts`.
 */

import { describe, expect, it } from "vitest";
import type { Session } from "@pideck/shared";

import { restPull } from "../../testing/fixtures.js";
import { checkRuns, makeHarness, PROJECT, redFakePR, REVIEW_USER, type Harness } from "./harness.js";

/** Tracks PR #12 owned by the harness's default worker, with full control over CI/reviews. */
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

/** A workerLike agent-kind session occupying a concurrency slot (issue #393). */
function workerLikeKindSession(id: string, kind: string): Session {
  return {
    id,
    projectId: PROJECT,
    role: "worker",
    tmuxSession: `pideck-${id}`,
    workerId: null,
    agentKind: kind,
    createdAt: "2026-09-06T12:00:00Z",
  };
}

describe("PullRequestPipeline: auto review agent — spawn (issue #107)", () => {
  it("spawns a review agent when a green PR is unreviewed, nested under the authoring worker", async () => {
    const h = greenHarness();
    await h.poll(); // discover + track (CI unknown at discovery) — reviewer spawns on the enriched pass
    await h.poll();

    expect(h.sessions.spawned).toHaveLength(1);
    expect(h.sessions.spawned[0]).toMatchObject({
      projectId: PROJECT,
      request: { prNumber: 12, parentWorkerId: "worker-1" },
    });
    expect(h.sessions.spawned[0]!.request.prompt).toContain("review agent for PR #12");
    expect(h.sessions.spawned[0]!.request.prompt).toContain("o/r");
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ reviewWorkerId: "worker-reviewer-1", reviewedHeadSha: "sha-1" });
    // The reviewer is a reviewer-kind worker carrying the PR.
    const reviewer = h.sessions.control.getWorker("worker-reviewer-1");
    expect(reviewer).toMatchObject({ kind: "reviewer", prNumber: 12, status: "running" });

    // Reviewer active, same head → no duplicate spawns.
    await h.poll();
    expect(h.sessions.spawned).toHaveLength(1);
  });

  it("does not spawn when the PR is red, the review cycle is gated off, or the host cannot spawn", async () => {
    const red = makeHarness();
    red.openList.push(12);
    red.prs.set(12, redFakePR());
    red.sessions.control.listWorkers()[0]!.prNumber = 12;
    await red.poll();
    await red.poll();
    expect(red.sessions.spawned).toHaveLength(0); // CI failure branch: no review cycle

    const gated = greenHarness({ workerSettings: () => ({ terminateOnMerge: true, autoFixCi: true, autoFixReviewComments: true, autoReview: false }) });
    await gated.poll();
    await gated.poll();
    expect(gated.sessions.spawned).toHaveLength(0);

    const noSpawn = greenHarness();
    delete (noSpawn.sessions.control as { spawnReviewAgent?: unknown }).spawnReviewAgent;
    await noSpawn.poll();
    await noSpawn.poll();
    expect(noSpawn.sessions.spawned).toHaveLength(0);
    expect(noSpawn.tracker.get(PROJECT, 12)).toMatchObject({ reviewWorkerId: null });
  });

  it("does not spawn a reviewer while the PR has merge conflicts, even when CI is green (issue #322)", async () => {
    const h = greenHarness();
    h.prs.get(12)!.pull = assignedPull({ sha: "sha-1", mergeConflicts: true });
    await h.poll();
    await h.poll();
    expect(h.sessions.spawned).toHaveLength(0);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ reviewWorkerId: null });

    // Conflicts resolved (author rebased) → the reviewer spawns on a later poll.
    h.prs.get(12)!.pull = assignedPull({ sha: "sha-1" });
    await h.poll();
    expect(h.sessions.spawned).toHaveLength(1);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ reviewWorkerId: "worker-reviewer-1", reviewedHeadSha: "sha-1" });
  });

  it("respects the project's worker concurrency cap and spawns when a slot frees", async () => {
    let cap: number | undefined = 1;
    const h = greenHarness({ workerCap: () => cap, fixPromptTimeoutMs: 1000 });
    // CI red first: the fix prompt keeps the author actively working
    // (`fixing_ci`) — it occupies the only slot, so no reviewer spawns.
    h.prs.get(12)!.checkRuns = checkRuns("failure");
    await h.poll();
    await h.poll();
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("fixing");

    // CI green but the author's fix prompt is still in flight → the author
    // holds the only slot → no reviewer spawn.
    h.prs.get(12)!.checkRuns = checkRuns("success");
    await h.poll();
    expect(h.sessions.spawned).toHaveLength(0);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ reviewWorkerId: null });

    // The prompt goes stale → the author rests (`done`, issue #411) → its
    // slot frees → the reviewer spawns.
    h.advance(2000);
    cap = 1;
    await h.poll();
    expect(h.sessions.spawned).toHaveLength(1);

    // Unbounded projects spawn immediately.
    const unbounded = greenHarness({ workerCap: () => undefined });
    await unbounded.poll();
    await unbounded.poll();
    expect(unbounded.sessions.spawned).toHaveLength(1);
  });

  it("counts workerLike kind sessions toward the cap too (issue #393)", async () => {
    // Cap 1: one workerLike kind session fills the project (the resting
    // author — `done` once CI passed, issue #411 — holds no slot). The
    // reviewer must NOT spawn. Terminating the kind session frees the slot.
    const kindSessions = [workerLikeKindSession("sess-kind-1", "devex-audit")];
    const h = greenHarness({ workerCap: () => 1, kindSessions });
    await h.poll();
    await h.poll();
    expect(h.sessions.spawned).toHaveLength(0);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ reviewWorkerId: null });

    // The kind session is archived (terminated) → its slot frees → spawn.
    kindSessions.length = 0;
    await h.poll();
    expect(h.sessions.spawned).toHaveLength(1);
  });
});

describe("PullRequestPipeline: auto review agent — re-review and lifecycle (issue #107)", () => {
  it("re-prompts the same reviewer after the author pushes, and archives it on approval", async () => {
    const h = greenHarness();
    await h.poll();
    await h.poll();
    expect(h.tracker.get(PROJECT, 12)!.reviewWorkerId).toBe("worker-reviewer-1");

    // Author pushes a follow-up commit; CI stays green → re-review prompt.
    h.prs.get(12)!.pull = assignedPull({ sha: "sha-2" });
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.sessions.prompts[0]).toEqual({ sessionId: "sess-reviewer-1", keys: expect.stringContaining("Re-review the updated diff") });
    expect(h.tracker.get(PROJECT, 12)!.reviewedHeadSha).toBe("sha-2");
    // Same head again → no duplicate re-review prompt.
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);

    // The reviewer approves → reviewer archived, cycle ends.
    h.prs.get(12)!.reviews = [{ user: { login: "worker-reviewer-1" }, state: "APPROVED", submitted_at: "2026-09-06T12:05:00Z" }];
    await h.poll();
    expect(h.sessions.archived).toEqual(["worker-reviewer-1"]);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ reviewWorkerId: null, reviewedHeadSha: null });
  });

  it("spawns a fresh reviewer when the previous one died without a decision", async () => {
    const h = greenHarness();
    await h.poll();
    await h.poll();
    h.sessions.control.updateWorkerStatus("worker-reviewer-1", "stopped", "pane died");
    await h.poll(); // dead reviewer + no decision → fresh spawn (same head is fine)
    expect(h.sessions.spawned).toHaveLength(2);
    expect(h.tracker.get(PROJECT, 12)!.reviewWorkerId).toBe("worker-reviewer-2");

    // But a dead reviewer that DID decide (changes requested) waits for the
    // author to push — and the decision itself prompts the author to fix
    // (issue #440), so the loop restarts instead of stalling.
    h.prs.get(12)!.reviews = [{ user: { login: "worker-reviewer-2" }, state: "CHANGES_REQUESTED", submitted_at: "2026-09-06T12:06:00Z" }];
    h.sessions.control.updateWorkerStatus("worker-reviewer-2", "stopped", "pane died");
    await h.poll();
    expect(h.sessions.spawned).toHaveLength(2);
    expect(h.sessions.prompts.some((p) => p.sessionId === "sess-1" && p.keys.includes("requested changes on your PR #12"))).toBe(true);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ state: "addressing", reviewFixAttempts: 1 });
  });

  it("archives the reviewer when the PR merges, closes, or the loop fails", async () => {
    const merged = greenHarness();
    await merged.poll();
    await merged.poll();
    merged.prs.get(12)!.pull = assignedPull({ sha: "sha-2", closed: true, merged: true });
    await merged.poll();
    expect(merged.sessions.archived).toContain("worker-reviewer-1");

    const closed = greenHarness();
    await closed.poll();
    await closed.poll();
    closed.prs.get(12)!.pull = assignedPull({ sha: "sha-2", closed: true });
    await closed.poll();
    expect(closed.sessions.archived).toContain("worker-reviewer-1");
  });

  it("archives the reviewer on approval even while CI is red (issue #441 B5)", async () => {
    const h = greenHarness();
    await h.poll();
    await h.poll();
    const reviewerId = h.tracker.get(PROJECT, 12)!.reviewWorkerId!;
    // The reviewer approves while CI is failing (a re-run went red) — the
    // approval is the round's end, so the reviewer must leave `running`
    // even though the CI-gated spawn gate no longer holds.
    h.prs.get(12)!.checkRuns = checkRuns("failure");
    h.prs.get(12)!.reviews = [{ user: { login: REVIEW_USER }, state: "APPROVED", submitted_at: "2026-09-06T12:05:00Z" }];
    await h.poll();
    expect(h.sessions.archived).toContain("worker-reviewer-1");
    expect(h.sessions.control.getWorker(reviewerId)!.status).toBe("archived");
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ reviewWorkerId: null, reviewedHeadSha: null });
  });

  it("falls back to a terminal status when archival fails at merge (issue #441 B5)", async () => {
    const h = greenHarness();
    await h.poll();
    await h.poll();
    const reviewerId = h.tracker.get(PROJECT, 12)!.reviewWorkerId!;
    // The pane's archive kills race-fails at merge — the linkage is cleared
    // either way, so no later poll would retry: the status write must still
    // land, or the reviewer idles forever as `running` on the board.
    h.sessions.control.archiveWorker = async () => {
      throw new Error("tmux kill-server failed");
    };
    h.prs.get(12)!.pull = assignedPull({ sha: "sha-2", closed: true, merged: true });
    await h.poll();
    expect(h.sessions.control.getWorker(reviewerId)!.status).toBe("archived");
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ reviewWorkerId: null });
  });
});
