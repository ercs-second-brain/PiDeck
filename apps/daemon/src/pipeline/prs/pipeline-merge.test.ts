/**
 * PR-pipeline merge-settlement tests: terminate-on-merge (issue #106,
 * default ON) and the legacy keep-running behavior when the toggle is off.
 * Shared fakes/harness: `harness.ts`.
 */

import { describe, expect, it } from "vitest";

import { restPull } from "../../testing/fixtures.js";
import { checkRuns, makeHarness, prEvents, PROJECT } from "./harness.js";

function greenApprovedFake(): { checkRuns: unknown; reviews: unknown[]; comments: unknown[] } {
  return {
    checkRuns: checkRuns("success"),
    reviews: [{ user: { login: "alice" }, state: "APPROVED", submitted_at: "2026-09-06T12:05:00Z" }],
    comments: [],
  };
}

describe("PullRequestPipeline: merge", () => {
  it("archives the worker on merge (terminateOnMerge default on) and keeps the card done", async () => {
    const h = makeHarness();
    h.openList.push(12);
    h.prs.set(12, { pull: restPull(12), ...greenApprovedFake() });
    h.sessions.control.listWorkers()[0]!.prNumber = 12;

    const first = prEvents(await h.poll());
    expect(first.at(-1)).toMatchObject({ card: { column: "in_review" } });

    // Merge → done card + worker archived (issue #106 default); merged PRs
    // drop out of the open list.
    h.prs.get(12)!.pull = restPull(12, { merged: true, closed: true });
    h.openList.length = 0;
    const events = await h.poll();
    const mergeCards = events.filter((e) => e.type === "kanban.pr.card");
    expect(mergeCards).toHaveLength(1);
    expect(mergeCards[0]).toMatchObject({ card: { column: "done" } });
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("done");
    expect(h.sessions.archived).toEqual(["worker-1"]);
    expect(h.sessions.statuses.at(-1)).toMatchObject({ status: "archived" });
    expect(await h.poll()).toEqual([]);
  });

  it("keeps the worker done (pane alive) on merge when terminateOnMerge is off", async () => {
    const h = makeHarness({ workerSettings: () => ({ terminateOnMerge: false, autoFixCi: true, autoFixReviewComments: true }) });
    h.openList.push(12);
    h.prs.set(12, { pull: restPull(12), ...greenApprovedFake() });
    h.sessions.control.listWorkers()[0]!.prNumber = 12;
    await h.poll();

    h.prs.get(12)!.pull = restPull(12, { merged: true, closed: true });
    h.openList.length = 0;
    await h.poll();
    expect(h.sessions.archived).toEqual([]);
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("done");
    expect(h.sessions.statuses.at(-1)).toMatchObject({ status: "done" });
  });
});
