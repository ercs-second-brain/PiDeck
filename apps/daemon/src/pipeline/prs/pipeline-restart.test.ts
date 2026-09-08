/**
 * PR-pipeline lifecycle tests: watcher-event registration and restart
 * resilience (persisted tracker + reconcile). Shared fakes: `harness.ts`.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PullRequest } from "@pideck/shared";

import { restPull } from "../../testing/fixtures.js";
import { PullRequestPipeline } from "./pipeline.js";
import type { PRPipelineEvent } from "./events.js";
import { fakeSessions, makeHarness, makeWorker, PROJECT, redFakePR, REPO } from "./harness.js";
import { PRTracker } from "./tracker.js";

describe("PullRequestPipeline: lifecycle", () => {
  it("handleWatcherEvent registers worker PRs before the next poll and restarts cleanly", async () => {
    const h = makeHarness();
    h.prs.set(12, redFakePR());
    const worker = h.sessions.control.listWorkers()[0]!;
    worker.prNumber = 12;

    const pr: PullRequest = {
      projectId: PROJECT,
      number: 12,
      title: "PR 12",
      state: "open",
      ciStatus: "failure",
      reviewState: "none",
      headBranch: "agent/issue-12",
      baseBranch: "main",
      author: "worker",
      url: "https://github.com/o/r/pull/12",
      updatedAt: "2026-09-06T12:00:00Z",
    };
    const events = h.pipeline.handleWatcherEvent({ type: "pull_request.opened", at: h.now().toISOString(), pullRequest: pr });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "kanban.pr.card", card: { number: 12, column: "in_review" } });

    // The next poll processes the tracked PR even though the discovery list
    // has not been refreshed (simulating the watcher being the only source).
    h.openList.length = 0;
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);

    // Duplicate events do not double-track.
    expect(h.pipeline.handleWatcherEvent({ type: "pull_request.updated", at: h.now().toISOString(), pullRequest: pr })).toEqual([]);
    expect(h.tracker.list()).toHaveLength(1);
  });

  it("restart: persisted tracker + registry reconcile resumes the loop and prunes lost workers", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pideck-prpipeline-"));
    const filePath = path.join(dir, "prs.json");
    const worker = makeWorker({ prNumber: 12 });
    const h = makeHarness({ workers: [worker], trackerPath: filePath });
    h.openList.push(12);
    h.prs.set(12, redFakePR());
    await h.poll();
    expect(h.sessions.prompts).toHaveLength(1);
    expect(h.tracker.get(PROJECT, 12)!.state).toBe("fixing");

    // Daemon restart: fresh tracker over the same file, fresh pipeline.
    const sessions2 = fakeSessions([worker]);
    const tracker2 = new PRTracker(filePath);
    const emitted2: PRPipelineEvent[] = [];
    const pipeline2 = new PullRequestPipeline({
      gh: h.gh,
      projectId: PROJECT,
      repo: REPO,
      sessions: sessions2.control,
      tracker: tracker2,
      emit: (event) => emitted2.push(event),
      now: h.now,
    });
    const reconcileEvents = pipeline2.reconcile();
    expect(reconcileEvents).toEqual([]); // worker still registered → nothing pruned
    expect(tracker2.get(PROJECT, 12)!.state).toBe("fixing");

    // The loop resumes: same head SHA → no duplicate prompt.
    await pipeline2.pollOnce();
    expect(sessions2.prompts).toHaveLength(0);

    // Worker pushes a fix and CI goes green → ends green without manual commands.
    h.prs.get(12)!.pull = restPull(12, { sha: "sha-2" });
    h.prs.get(12)!.checkRuns = { total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] };
    await pipeline2.pollOnce();
    expect(sessions2.prompts).toHaveLength(0);
    expect(tracker2.get(PROJECT, 12)).toMatchObject({ state: "watching", fixAttempts: 0 });

    // If the worker record is gone, reconcile fails the tracked PR.
    const sessions3 = fakeSessions([]);
    const pipeline3 = new PullRequestPipeline({
      gh: h.gh,
      projectId: PROJECT,
      repo: REPO,
      sessions: sessions3.control,
      tracker: tracker2,
      emit: (event) => emitted2.push(event),
      now: h.now,
    });
    tracker2.get(PROJECT, 12)!.state = "watching";
    const lost = pipeline3.reconcile();
    expect(lost).toHaveLength(2);
    expect(lost[1]).toMatchObject({ type: "kanban.pr.failed", prNumber: 12, reason: "worker_lost" });
    expect(tracker2.get(PROJECT, 12)!.state).toBe("failed");
  });
});
