/**
 * IssueSpawnPipeline idle-worker-reuse tests (issue #471): the ReusePolicy
 * is consulted BEFORE a fresh spawn; a lane-carrying task with an eligible
 * `done` same-lane worker re-tasks it (no fresh spawn, kanban card moves
 * to the reused worker); anything else spawns fresh — and a task with NO
 * lane never consults reuse (the deterministic fresh-spawn default).
 */

import { describe, expect, it } from "vitest";
import type { Worker } from "@pideck/shared";
import { QueueingScheduler } from "./scheduler.js";
import { IssueSpawnPipeline } from "./pipeline.js";
import type { BlockerResolver, WorkerSpawner } from "./ports.js";
import type { ReusePolicy, ReuseRequest } from "./reuse.js";
import { makeIssue } from "../../testing/fixtures.js";
import { PROJECT_ID, REPO, flush, issueAssigned, makeProject, spawnKeys } from "./pipeline-cap.test.js";

const NOW = "2026-09-06T12:00:00Z";

/** Spawner fake that records lane metadata and retasks. */
function fakeSpawner(): {
  spawner: WorkerSpawner;
  spawns: Array<{ projectId: string; issueNumber: number; lane?: string }>;
  retasks: Array<{ workerId: string; issueNumber: number; prompt: string }>;
} {
  const spawns: Array<{ projectId: string; issueNumber: number; lane?: string }> = [];
  const retasks: Array<{ workerId: string; issueNumber: number; prompt: string }> = [];
  const active = new Set<number>();
  const spawner: WorkerSpawner = {
    async spawnWorker(projectId, issueNumber, _prompt, options) {
      spawns.push({ projectId, issueNumber, ...(options?.lane !== undefined ? { lane: options.lane } : {}) });
      active.add(issueNumber);
      const n = spawns.length;
      const worker: Worker = {
        id: `worker-${n}`,
        projectId,
        sessionId: `sess-${n}`,
        issueNumber,
        prNumbers: [],
        status: "running",
        statusMessage: "agent running",
        startedAt: NOW,
        updatedAt: NOW,
        ...(options?.lane !== undefined ? { lane: options.lane } : {}),
      };
      return {
        session: { id: `sess-${n}`, projectId, role: "worker", tmuxSession: `tmux-${n}`, workerId: worker.id, createdAt: NOW },
        worker,
      };
    },
    async retaskWorker(workerId, issueNumber, prompt) {
      retasks.push({ workerId, issueNumber, prompt });
      return {
        id: workerId,
        projectId: PROJECT_ID,
        sessionId: "sess-0",
        issueNumber,
        prNumbers: [],
        status: "running",
        statusMessage: "follow-on task assigned (worker reuse, issue #471)",
        startedAt: NOW,
        updatedAt: NOW,
        lane: "backend",
      };
    },
    async listActiveWorkerIssueNumbers() {
      return new Set(active);
    },
    async archiveWorkersForIssue() {
      return [];
    },
  };
  return { spawner, spawns, retasks };
}

/** Scripted reuse policy: per-lane answer + the requests it saw. */
function fakeReusePolicy(answer: (request: ReuseRequest) => Worker | null): { policy: ReusePolicy; requests: ReuseRequest[] } {
  const requests: ReuseRequest[] = [];
  return {
    requests,
    policy: {
      async findReusableWorker(request) {
        requests.push(request);
        return answer(request);
      },
    },
  };
}

function reusableWorker(): Worker {
  return {
    id: "worker-idle",
    projectId: PROJECT_ID,
    sessionId: "sess-0",
    issueNumber: 11,
    prNumbers: [222],
    status: "done",
    statusMessage: "done",
    startedAt: NOW,
    updatedAt: NOW,
    lane: "backend",
  };
}

function makePipeline(options: {
  spawner: WorkerSpawner;
  reusePolicy?: ReusePolicy;
  workerSettings?: () => { workerReuseContextThreshold: number } | undefined;
  laneFor?: (issueNumber: number) => string | undefined;
}) {
  const errors: unknown[] = [];
  const blockers: BlockerResolver = { resolve: async () => [] }; // never blocked in these tests
  const pipeline = new IssueSpawnPipeline({
    projects: { get: (id) => (id === PROJECT_ID ? { project: makeProject(), repo: REPO } : undefined) },
    blockers,
    spawner: options.spawner,
    scheduler: new QueueingScheduler({ spawner: options.spawner, onError: (err) => errors.push(err) }),
    ...(options.reusePolicy !== undefined ? { reusePolicy: options.reusePolicy } : {}),
    ...(options.workerSettings !== undefined
      ? { workerSettings: options.workerSettings as never }
      : {}),
    ...(options.laneFor !== undefined ? { laneFor: () => options.laneFor?.(1) } : {}),
    now: () => new Date(NOW),
    onError: (err) => errors.push(err),
  });
  const kanbanEvents: unknown[] = [];
  pipeline.kanbanEvents.on((event) => kanbanEvents.push(event));
  return { pipeline, kanbanEvents, errors };
}

describe("IssueSpawnPipeline reuse (issue #471)", () => {
  it("re-tasks an eligible same-lane worker instead of spawning fresh", async () => {
    const { spawner, spawns, retasks } = fakeSpawner();
    const { policy, requests } = fakeReusePolicy(() => reusableWorker());
    const { pipeline, kanbanEvents } = makePipeline({
      spawner,
      reusePolicy: policy,
      workerSettings: () => ({ workerReuseContextThreshold: 20 }),
      laneFor: () => "backend",
    });

    pipeline.handleEvent(issueAssigned(makeIssue(5)));
    await flush();

    expect(requests).toEqual([{ projectId: PROJECT_ID, lane: "backend", thresholdPct: 20 }]);
    expect(retasks).toHaveLength(1);
    expect(retasks[0]?.workerId).toBe("worker-idle");
    expect(retasks[0]?.issueNumber).toBe(5);
    expect(spawns).toHaveLength(0); // no fresh spawn
    // The kanban card moves to the REUSED worker.
    expect(kanbanEvents).toHaveLength(1);
    const event = kanbanEvents[0] as { card?: { workerId?: string } };
    expect(event.card?.workerId).toBe("worker-idle");
  });

  it("spawns fresh (lane recorded) when the policy finds no eligible worker", async () => {
    const { spawner, spawns, retasks } = fakeSpawner();
    const { policy, requests } = fakeReusePolicy(() => null);
    const { pipeline } = makePipeline({
      spawner,
      reusePolicy: policy,
      workerSettings: () => ({ workerReuseContextThreshold: 20 }),
      laneFor: () => "backend",
    });

    pipeline.handleEvent(issueAssigned(makeIssue(5)));
    await flush();

    expect(requests).toHaveLength(1); // consulted before the fresh spawn
    expect(retasks).toHaveLength(0);
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#5`]);
    expect(spawns[0]?.lane).toBe("backend"); // the lane rides the fresh spawn
  });

  it("never consults reuse for a lane-less task (deterministic fresh spawn)", async () => {
    const { spawner, spawns, retasks } = fakeSpawner();
    const { policy, requests } = fakeReusePolicy(() => reusableWorker());
    const { pipeline } = makePipeline({
      spawner,
      reusePolicy: policy,
      workerSettings: () => ({ workerReuseContextThreshold: 20 }),
      laneFor: () => undefined,
    });

    pipeline.handleEvent(issueAssigned(makeIssue(5)));
    await flush();

    expect(requests).toHaveLength(0); // no lane ⇒ no consult, no reuse
    expect(retasks).toHaveLength(0);
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#5`]);
    expect(spawns[0]?.lane).toBeUndefined();
  });

  it("resolves the threshold fresh per decision (per-project override wins)", async () => {
    const { spawner } = fakeSpawner();
    const { policy, requests } = fakeReusePolicy(() => null);
    let threshold = 20;
    const { pipeline } = makePipeline({
      spawner,
      reusePolicy: policy,
      workerSettings: () => ({ workerReuseContextThreshold: threshold }),
      laneFor: () => "backend",
    });

    pipeline.handleEvent(issueAssigned(makeIssue(5)));
    await flush();
    threshold = 50;
    pipeline.handleEvent(issueAssigned(makeIssue(6)));
    await flush();

    expect(requests.map((r) => r.thresholdPct)).toEqual([20, 50]);
  });

  it("without a reuse policy the pipeline spawns fresh exactly as today", async () => {
    const { spawner, spawns } = fakeSpawner();
    const { pipeline } = makePipeline({ spawner, laneFor: () => "backend" });

    pipeline.handleEvent(issueAssigned(makeIssue(5)));
    await flush();

    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#5`]);
    expect(spawns[0]?.lane).toBe("backend");
  });
});
