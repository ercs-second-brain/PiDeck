/**
 * Merge-driven unblock sweep (issue #408, flow step 8): spawns suppressed by
 * open blockers are recorded, and `sweepUnblocked` — triggered by the wiring
 * when a PR merges — re-evaluates them through the SAME spawn matrix. Tests
 * cover the unblock, the still-blocked retention, the conflict avoidance
 * (dedupe against running workers) and the #393 occupancy gate. Shared
 * fakes: `pipeline-cap.test.ts`.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Project } from "@pideck/shared";

import { BlockedTicketStore } from "./blocked-store.js";
import { IssueSpawnPipeline } from "./pipeline.js";
import { makeIssue } from "../../testing/fixtures.js";
import {
  flush,
  makeProject,
  scriptedBlockerResolver,
  spawnKeys,
  PROJECT_ID,
  REPO,
  type BlockerScript,
} from "./pipeline-cap.test.js";
import { QueueingScheduler } from "./scheduler.js";
import type { RegisteredProject, WorkerSpawner } from "./ports.js";
import type { SpawnedWorker } from "../../sessions/manager.js";

function fakeSpawner(options: { active?: number[] } = {}): {
  spawner: WorkerSpawner;
  spawns: Array<{ projectId: string; issueNumber: number }>;
} {
  const spawns: Array<{ projectId: string; issueNumber: number }> = [];
  const spawner: WorkerSpawner = {
    async spawnWorker(projectId, issueNumber) {
      spawns.push({ projectId, issueNumber });
      const n = spawns.length;
      const spawned: SpawnedWorker = {
        session: {
          id: `sess-${n}`,
          projectId,
          role: "worker",
          tmuxSession: `pideck-${projectId}-worker-${n}`,
          workerId: `worker-${n}`,
          createdAt: "2026-09-06T12:00:00Z",
        },
        worker: {
          id: `worker-${n}`,
          projectId,
          sessionId: `sess-${n}`,
          issueNumber,
          prNumbers: [],
          status: "running",
          statusMessage: null,
          startedAt: "2026-09-06T12:00:00Z",
          updatedAt: "2026-09-06T12:00:00Z",
        },
      };
      return spawned;
    },
    async listActiveWorkerIssueNumbers() {
      return new Set(options.active ?? []);
    },
    async archiveWorkersForIssue() {
      return [];
    },
  };
  return { spawner, spawns };
}

function makeHarness(options: {
  blockerScript: BlockerScript;
  spawner: WorkerSpawner;
  workerConcurrency?: number;
  occupants?: number;
  /** Issue #427: pass a persisted store to exercise restart semantics. */
  blockedStore?: BlockedTicketStore;
}): { pipeline: IssueSpawnPipeline; spawns: Array<{ projectId: string; issueNumber: number }> } {
  const settings: Project["settings"] = {
    ...makeProject().settings,
    ...(options.workerConcurrency !== undefined ? { workerConcurrency: options.workerConcurrency } : {}),
  };
  const project: Project = { ...makeProject(), settings };
  const projects = new Map<string, RegisteredProject>([[PROJECT_ID, { project, repo: REPO }]]);
  const pipeline = new IssueSpawnPipeline({
    projects: { get: (id) => projects.get(id) },
    blockers: scriptedBlockerResolver(options.blockerScript),
    spawner: options.spawner,
    scheduler: new QueueingScheduler({ spawner: options.spawner, pollIntervalMs: 0 }),
    ...(options.occupants !== undefined ? { countOccupants: () => options.occupants as number } : {}),
    ...(options.blockedStore !== undefined ? { blockedStore: options.blockedStore } : {}),
    now: () => new Date("2026-09-06T12:00:00Z"),
    onError: (err) => {
      throw err;
    },
  });
  return { pipeline, spawns: spawnsOf(options.spawner) };
}

/** The fake spawner records its own spawns — reach them via that array. */
function spawnsOf(spawner: WorkerSpawner): Array<{ projectId: string; issueNumber: number }> {
  return (spawner as unknown as { spawns: Array<{ projectId: string; issueNumber: number }> }).spawns;
}

describe("IssueSpawnPipeline unblock sweep (issue #408)", () => {
  it("records a blocked ticket and spawns it when a merge closes the blockers", async () => {
    const script: BlockerScript = new Map([[5, [{ number: 2, state: "open", repository: null }]]]);
    const { spawner, spawns } = fakeSpawner();
    const { pipeline } = makeHarness({ blockerScript: script, spawner });

    pipeline.handleEvent({ type: "issue.assigned", at: "2026-09-06T12:00:00Z", issue: issue5Blocked() });
    await flush();
    expect(spawns).toHaveLength(0);
    expect(pipeline.isRecordedBlocked(PROJECT_ID, 5)).toBe(true);

    // The PR merging closes issue #2 → the sweep re-resolves and spawns.
    script.set(5, [{ number: 2, state: "closed", repository: null }]);
    await pipeline.sweepUnblocked(PROJECT_ID);
    await flush();
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#5`]);
    expect(pipeline.isRecordedBlocked(PROJECT_ID, 5)).toBe(false); // consumed
  });

  it("keeps the ticket recorded while any blocker is still open", async () => {
    const script: BlockerScript = new Map([[5, [{ number: 2, state: "open", repository: null }]]]);
    const { spawner, spawns } = fakeSpawner();
    const { pipeline } = makeHarness({ blockerScript: script, spawner });

    pipeline.handleEvent({ type: "issue.assigned", at: "2026-09-06T12:00:00Z", issue: issue5Blocked() });
    await flush();

    // Only #2 closed (its PR merged); #3 is still open.
    script.set(5, [{ number: 2, state: "closed", repository: null }, { number: 3, state: "open", repository: null }]);
    await pipeline.sweepUnblocked(PROJECT_ID);
    await flush();
    expect(spawns).toHaveLength(0);
    expect(pipeline.isRecordedBlocked(PROJECT_ID, 5)).toBe(true);
  });

  it("never conflicts with a running worker: a ticket that gained a worker is dropped", async () => {
    const script: BlockerScript = new Map([[5, [{ number: 2, state: "open", repository: null }]]]);
    const { spawner, spawns } = fakeSpawner({ active: [5] });
    const { pipeline } = makeHarness({ blockerScript: script, spawner });

    pipeline.handleEvent({ type: "issue.assigned", at: "2026-09-06T12:00:00Z", issue: issue5Blocked() });
    await flush();
    expect(pipeline.isRecordedBlocked(PROJECT_ID, 5)).toBe(true);

    // The worker exists: the sweep drops the ticket without spawning.
    await pipeline.sweepUnblocked(PROJECT_ID);
    await flush();
    expect(spawns).toHaveLength(0);
    expect(pipeline.isRecordedBlocked(PROJECT_ID, 5)).toBe(false);
  });

  it("a capped project at its occupancy limit holds the ticket for the next sweep", async () => {
    const script: BlockerScript = new Map([[5, [{ number: 2, state: "open", repository: null }]]]);
    const { spawner, spawns } = fakeSpawner();
    const { pipeline } = makeHarness({ blockerScript: script, spawner, workerConcurrency: 1, occupants: 1 });

    pipeline.handleEvent({ type: "issue.assigned", at: "2026-09-06T12:00:00Z", issue: issue5Blocked() });
    await flush();
    expect(pipeline.isRecordedBlocked(PROJECT_ID, 5)).toBe(true);

    // Occupancy 1 ≥ cap 1: the sweep holds the ticket (retried next merge).
    script.set(5, []);
    await pipeline.sweepUnblocked(PROJECT_ID);
    await flush();
    expect(spawns).toHaveLength(0);
    expect(pipeline.isRecordedBlocked(PROJECT_ID, 5)).toBe(true);
  });

  it("a blocked ticket survives a restart and unblocks on the next merge (issue #427)", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "pideck-blocked-")), "blocked.json");
    const script: BlockerScript = new Map([[5, [{ number: 2, state: "open", repository: null }]]]);
    const { spawner, spawns } = fakeSpawner();

    // Before the fix: the map was in-memory, so this first pipeline's
    // record vanished with it — no redelivery ever re-triggered #5.
    const before = makeHarness({ blockerScript: script, spawner, blockedStore: new BlockedTicketStore(file) }).pipeline;
    before.handleEvent({ type: "issue.assigned", at: "2026-09-06T12:00:00Z", issue: issue5Blocked() });
    await flush();
    expect(before.isRecordedBlocked(PROJECT_ID, 5)).toBe(true);

    // Restart: a fresh pipeline hydrates the blocked map from disk.
    const after = makeHarness({ blockerScript: script, spawner, blockedStore: new BlockedTicketStore(file) }).pipeline;
    expect(after.isRecordedBlocked(PROJECT_ID, 5)).toBe(true);

    // The PR merging closes the blocker: the restarted pipeline's sweep
    // re-evaluates the persisted ticket and spawns through the matrix.
    script.set(5, []);
    await after.sweepUnblocked(PROJECT_ID);
    await flush();
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#5`]);
    expect(after.isRecordedBlocked(PROJECT_ID, 5)).toBe(false); // consumed + persisted
    expect(new BlockedTicketStore(file).isRecorded(PROJECT_ID, 5)).toBe(false);
  });
});

function issue5Blocked(): ReturnType<typeof makeIssue> {
  return makeIssue(5, { blockers: [{ number: 2, state: "open", repository: null }] });
}
