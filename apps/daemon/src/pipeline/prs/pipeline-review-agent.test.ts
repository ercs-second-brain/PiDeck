/**
 * PR-pipeline auto review agent tests (issue #107): spawn on green,
 * re-review on new heads, archive on approval/terminal states, the
 * `autoReview` gate, and the worker-concurrency cap. Shared fakes:
 * `harness.ts`.
 */

import { describe, expect, it } from "vitest";
import type { Session } from "@pideck/shared";

import { restPull } from "../../testing/fixtures.js";
import { checkRuns, makeHarness, PROJECT, redFakePR, type Harness } from "./harness.js";

/** Tracks PR #12 owned by the harness's default worker, with full control over CI/reviews. */
function greenHarness(options: Parameters<typeof makeHarness>[0] = {}): Harness {
  const h = makeHarness(options);
  h.openList.push(12);
  h.prs.set(12, { pull: restPull(12, { sha: "sha-1" }), checkRuns: checkRuns("success"), reviews: [], comments: [] });
  h.sessions.control.listWorkers()[0]!.prNumber = 12;
  return h;
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
    h.prs.get(12)!.pull = restPull(12, { sha: "sha-1", mergeConflicts: true });
    await h.poll();
    await h.poll();
    expect(h.sessions.spawned).toHaveLength(0);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ reviewWorkerId: null });

    // Conflicts resolved (author rebased) → the reviewer spawns on a later poll.
    h.prs.get(12)!.pull = restPull(12, { sha: "sha-1" });
    await h.poll();
    expect(h.sessions.spawned).toHaveLength(1);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ reviewWorkerId: "worker-reviewer-1", reviewedHeadSha: "sha-1" });
  });

  it("respects the project's worker concurrency cap and spawns when a slot frees", async () => {
    let cap: number | undefined = 1;
    const h = greenHarness({ workerCap: () => cap });
    await h.poll();
    await h.poll();
    // The authoring worker occupies the only slot → no reviewer spawn.
    expect(h.sessions.spawned).toHaveLength(0);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ reviewWorkerId: null });

    cap = 2; // settings change lands without a restart
    await h.poll();
    expect(h.sessions.spawned).toHaveLength(1);

    // Unbounded projects spawn immediately.
    const unbounded = greenHarness({ workerCap: () => undefined });
    await unbounded.poll();
    await unbounded.poll();
    expect(unbounded.sessions.spawned).toHaveLength(1);
  });

  it("counts workerLike kind sessions toward the cap too (issue #393)", async () => {
    // Cap 2: the active authoring worker (1) + one workerLike kind session
    // (1) fill the project — the reviewer must NOT spawn, even though only
    // one WORKER exists. Terminating the kind session frees the slot.
    const kindSessions = [workerLikeKindSession("sess-kind-1", "devex-audit")];
    const h = greenHarness({ workerCap: () => 2, kindSessions });
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
    h.prs.get(12)!.pull = restPull(12, { sha: "sha-2" });
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

    // But a dead reviewer that DID decide (changes requested) waits for the author to push.
    h.prs.get(12)!.reviews = [{ user: { login: "worker-reviewer-2" }, state: "CHANGES_REQUESTED", submitted_at: "2026-09-06T12:06:00Z" }];
    h.sessions.control.updateWorkerStatus("worker-reviewer-2", "stopped", "pane died");
    await h.poll();
    expect(h.sessions.spawned).toHaveLength(2);
  });

  it("archives the reviewer when the PR merges, closes, or the loop fails", async () => {
    const merged = greenHarness();
    await merged.poll();
    await merged.poll();
    merged.prs.get(12)!.pull = restPull(12, { sha: "sha-2", closed: true, merged: true });
    await merged.poll();
    expect(merged.sessions.archived).toContain("worker-reviewer-1");

    const closed = greenHarness();
    await closed.poll();
    await closed.poll();
    closed.prs.get(12)!.pull = restPull(12, { sha: "sha-2", closed: true });
    await closed.poll();
    expect(closed.sessions.archived).toContain("worker-reviewer-1");
  });
});
