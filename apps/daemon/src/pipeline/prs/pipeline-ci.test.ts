/**
 * PR-pipeline CI-fix loop tests: bounded attempts, stale-prompt re-prompt,
 * and the `autoFixCi` gate (issue #106). Shared fakes/harness: `harness.ts`.
 */

import { describe, expect, it } from "vitest";

import { restPull } from "../../testing/fixtures.js";
import { checkRuns, makeHarness, PROJECT, redFakePR, restComment } from "./harness.js";

describe("PullRequestPipeline: CI-fix loop", () => {
  it("bounds the fix loop: exhausted attempts mark the PR failed and stop prompting", async () => {
    const h = makeHarness({ maxFixAttempts: 2 });
    h.openList.push(12);
    h.prs.set(12, redFakePR());
    h.sessions.control.listWorkers()[0]!.prNumbers = [12];

    // Attempt 1 (sha-1), worker pushes, still red.
    expect((await h.poll()).length).toBeGreaterThan(0);
    h.prs.get(12)!.pull = restPull(12, { sha: "sha-2" });
    expect((await h.poll()).filter((e) => e.type === "kanban.pr.failed")).toEqual([]);

    // Attempt 2, worker pushes, still red → limit reached.
    h.prs.get(12)!.pull = restPull(12, { sha: "sha-3" });
    const events = await h.poll();
    expect(h.sessions.prompts).toHaveLength(2); // exactly maxFixAttempts prompts
    const failed = events.filter((e) => e.type === "kanban.pr.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      type: "kanban.pr.failed",
      projectId: PROJECT,
      prNumber: 12,
      workerId: "worker-1",
      reason: expect.stringContaining("fix_attempt_limit_exhausted"),
    });
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("failed");
    expect(h.sessions.statuses.at(-1)).toMatchObject({ status: "failed" });

    // Terminal: further polls do nothing at all.
    h.prs.get(12)!.pull = restPull(12, { sha: "sha-4" });
    expect(await h.poll()).toEqual([]);
    expect(h.sessions.prompts).toHaveLength(2);
  });

  it("re-prompts when the worker never acts on a fix prompt (stale timeout, still bounded)", async () => {
    const h = makeHarness({ maxFixAttempts: 2, fixPromptTimeoutMs: 1000 });
    h.openList.push(12);
    h.prs.set(12, redFakePR());
    h.sessions.control.listWorkers()[0]!.prNumbers = [12];

    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
    h.advance(2000);
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(2);
    expect(h.tracker.get(PROJECT, 12)!.fixAttempts).toBe(2);
    h.advance(2000);
    await h.poll(); // would be attempt 3 — past the limit
    expect(h.sessions.prompts).toHaveLength(2);
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("failed");
  });

  it("skips the CI-fix prompt when autoFixCi is off (issue #106)", async () => {
    const h = makeHarness({ workerSettings: () => ({ terminateOnMerge: true, autoFixCi: false, autoFixReviewComments: true, autoReview: false, workerReuseContextThreshold: 20 }) });
    h.openList.push(12);
    h.prs.set(12, redFakePR());
    h.sessions.control.listWorkers()[0]!.prNumbers = [12];

    // Polls never send a fix prompt; the worker's status says why.
    const events = await h.poll();
    expect(h.sessions.prompts).toHaveLength(0);
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("watching");
    expect(h.sessions.statuses.at(-1)).toMatchObject({
      status: "awaiting_ci",
      statusMessage: expect.stringContaining("auto-fix CI disabled"),
    });
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(0);
    // No repeated identical status broadcasts (no churn on the hub).
    expect(h.sessions.statuses).toHaveLength(2); // initial tracking + the disabled notice
    expect(events.some((e) => e.type === "kanban.pr.card")).toBe(true);
  });

  it("skips review-comment delivery when autoFixReviewComments is off (issue #106)", async () => {
    const h = makeHarness({ workerSettings: () => ({ terminateOnMerge: true, autoFixCi: true, autoFixReviewComments: false, autoReview: false, workerReuseContextThreshold: 20 }) });
    h.openList.push(12);
    h.prs.set(12, {
      pull: restPull(12, { sha: "sha-1" }),
      checkRuns: checkRuns("success"),
      reviews: [],
      comments: [],
    });
    h.sessions.control.listWorkers()[0]!.prNumbers = [12];
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(0);

    // New review comment → no addressing prompt; the status says why.
    h.prs.get(12)!.comments = [restComment(101, "Rename this variable")];
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(0);
    expect(h.sessions.statuses.at(-1)).toMatchObject({
      status: "awaiting_ci",
      statusMessage: expect.stringContaining("auto-fix review comments disabled"),
    });
    // No repeated identical status broadcasts (no churn on the hub). Issue
    // #411: poll 1 additionally moved the green-PR author to `done` (the
    // B34 transition) — the gated notice rides on top and then dedupes.
    await h.poll();
    expect(h.sessions.statuses).toHaveLength(3);
  });
});

describe("PullRequestPipeline: multi-PR worker (issue #470)", () => {
  it("tracks and drives every PR of a multi-PR worker (stacked/sibling branches)", async () => {
    const h = makeHarness();
    const worker = h.sessions.control.listWorkers()[0]!;
    worker.prNumbers = [12, 15];
    h.openList.push(12, 15);
    h.prs.set(12, redFakePR());
    h.prs.set(15, redFakePR(15));

    const events = await h.poll();

    // Both PRs track against the same worker — the namespace association is
    // many-to-many now (registration + first column-move cards per PR).
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ workerId: "worker-1", sessionId: "sess-1" });
    expect(h.tracker.get(PROJECT, 15)).toMatchObject({ workerId: "worker-1", sessionId: "sess-1" });
    const cardIds = new Set(events.filter((e) => e.type === "kanban.pr.card").map((e) => e.card.id));
    expect(cardIds).toEqual(new Set([`pr:${PROJECT}:12`, `pr:${PROJECT}:15`]));

    // Both red PRs drive independently: one bounded CI-fix prompt each, both
    // reaching the author's pane.
    expect(h.sessions.prompts.map((p) => p.sessionId)).toEqual(["sess-1", "sess-1"]);
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("fixing");
    expect(h.tracker.get(PROJECT, 15)!.state).toBe("fixing");
  });
});
