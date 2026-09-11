/**
 * PR-pipeline tests: tracking/discovery and the core red→green cycle
 * (issue #11). Gates (#106) live in `pipeline-*.test.ts` by theme; the
 * shared fakes/harness live in `harness.ts`.
 */

import { describe, expect, it } from "vitest";

import { restPull } from "../../testing/fixtures.js";
import { DEFAULT_MAX_FIX_ATTEMPTS } from "./pipeline.js";
import { checkRuns, makeHarness, prEvents, PROJECT, redFakePR } from "./harness.js";

describe("PullRequestPipeline", () => {
  it("tracks a PR through the opened event path and ignores PRs with no owning worker", async () => {
    const h = makeHarness();
    h.openList.push(12);
    h.prs.set(12, redFakePR());

    // Worker has no prNumber yet → PR is not tracked.
    expect(await h.poll()).toEqual([]);
    expect(h.tracker.list()).toEqual([]);

    // The wiring records the PR on the worker (SessionManager.setWorkerPr).
    h.sessions.control.listWorkers()[0]!.prNumbers = [12];

    const events = prEvents(await h.poll());
    // Discovery card (CI not yet enriched → in_progress), then the enriched
    // red-CI card moves to in_review via the shared kanban mapping.
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "kanban.pr.card",
      card: { kind: "pull_request", number: 12, column: "in_progress", workerId: "worker-1", projectId: PROJECT },
    });
    expect(events[1]).toMatchObject({ card: { number: 12, column: "in_review" } });
    // A red PR is prompted in the same pass it is tracked.
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ state: "fixing", fixAttempts: 1 });
  });

  it("red → fix prompt → worker pushes → green (no manual commands)", async () => {
    const h = makeHarness();
    h.openList.push(12);
    h.prs.set(12, redFakePR());
    const worker = h.sessions.control.listWorkers()[0]!;
    worker.prNumbers = [12];

    // Poll 1: red → CI-fix prompt to the worker's session.
    const events = await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.sessions.prompts[0]).toEqual({ sessionId: "sess-1", keys: expect.stringContaining("CI is failing on your PR #12") });
    expect(h.sessions.prompts[0]!.keys).toContain("attempt 1 of " + DEFAULT_MAX_FIX_ATTEMPTS);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ state: "fixing", fixAttempts: 1 });
    expect(h.sessions.statuses.at(-1)).toMatchObject({ workerId: "worker-1", status: "fixing_ci" });
    expect(prEvents(events).at(-1)).toMatchObject({ card: { column: "in_review" } });

    // Poll 2: worker has not pushed yet (same head SHA) → no duplicate prompt.
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);

    // Poll 3: worker pushed, CI green → no prompt, attempt counter reset.
    // Issue #411: CI passing is platform truth — the passively watching
    // author leaves `awaiting_ci` for the resting `done` status in the same
    // poll (a red CI or review findings wake it deterministically).
    const fake = h.prs.get(12)!;
    fake.pull = restPull(12, { sha: "sha-2" });
    fake.checkRuns = checkRuns("success");
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.tracker.get(PROJECT, 12)).toMatchObject({ state: "watching", fixAttempts: 0 });
    expect(h.sessions.statuses.at(-1)).toMatchObject({ status: "done", statusMessage: expect.stringContaining("CI green") });

    // Poll 4: approved → the card already sits in in_review (settled CI) per
    // the shared kanban mapping — no new card event, no further prompts.
    // (Under the unified mapping only a merge moves a PR card to done.)
    fake.reviews = [{ user: { login: "alice" }, state: "APPROVED", submitted_at: "2026-09-06T12:10:00Z" }];
    const events4 = prEvents(await h.poll());
    expect(events4).toHaveLength(0);
    expect(h.sessions.prompts).toHaveLength(1);
  });
});
