import { describe, expect, it, vi } from "vitest";

import { QueueingScheduler, UnboundedScheduler, type SpawnRequest } from "./scheduler.js";
import type { WorkerSpawner } from "./ports.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A controllable worker registry: tests decide which issues have a
 * non-terminal worker per project (mirrors `listActiveWorkerIssueNumbers`).
 */
function fakeRegistry(initial: Record<string, number[]> = {}): {
  active: Map<string, Set<number>>;
  spawner: Pick<WorkerSpawner, "listActiveWorkerIssueNumbers">;
  stopWorker: (projectId: string, issueNumber: number) => void;
  activeSet: (projectId: string) => Set<number>;
} {
  const active = new Map<string, Set<number>>();
  for (const [projectId, issues] of Object.entries(initial)) active.set(projectId, new Set(issues));
  return {
    active,
    spawner: {
      async listActiveWorkerIssueNumbers(projectId) {
        return new Set(active.get(projectId) ?? []);
      },
    },
    stopWorker(projectId, issueNumber) {
      active.get(projectId)?.delete(issueNumber);
    },
    activeSet(projectId) {
      let set = active.get(projectId);
      if (set === undefined) {
        set = new Set<number>();
        active.set(projectId, set);
      }
      return set;
    },
  };
}

function request(projectId: string, issueNumber: number, maxConcurrentWorkers?: number): SpawnRequest {
  return { projectId, issueNumber, maxConcurrentWorkers };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// UnboundedScheduler
// ---------------------------------------------------------------------------

describe("UnboundedScheduler", () => {
  it("starts every task immediately, ignoring the request", async () => {
    const started: number[] = [];
    const scheduler = new UnboundedScheduler();
    for (const n of [1, 2, 3]) {
      scheduler.schedule(async () => {
        started.push(n);
      }, request("proj", n, 1));
    }
    await flush();
    expect(started).toEqual([1, 2, 3]);
  });

  it("reports task errors through onError", async () => {
    const errors: unknown[] = [];
    const scheduler = new UnboundedScheduler((err) => errors.push(err));
    scheduler.schedule(async () => {
      throw new Error("boom");
    });
    await flush();
    expect(errors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// QueueingScheduler
// ---------------------------------------------------------------------------

describe("QueueingScheduler", () => {
  it("spawns immediately for projects without a cap (default unbounded)", async () => {
    const { spawner } = fakeRegistry();
    const started: number[] = [];
    const scheduler = new QueueingScheduler({ spawner, pollIntervalMs: 0 });

    for (const n of [1, 2, 3]) scheduler.schedule(() => run(started, n), request("proj", n));

    await flush();
    expect(started).toEqual([1, 2, 3]);
  });

  it("respects the cap under concurrent events: at most N tasks start", async () => {
    const registry = fakeRegistry();
    const started: number[] = [];
    const scheduler = new QueueingScheduler({ spawner: registry.spawner, pollIntervalMs: 0 });

    // Each task "registers" its worker as active (spawn succeeded).
    const spawn = (n: number) => async () => {
      started.push(n);
      registry.activeSet("proj").add(n);
    };
    for (const n of [1, 2, 3, 4, 5]) scheduler.schedule(spawn(n), request("proj", n, 2));

    await flush();
    // Cap 2: issues 1 and 2 spawn; 3–5 stay queued even though the tasks settled.
    expect(started).toEqual([1, 2]);
  });

  it("drains the queue FIFO as workers finish (slot freed)", async () => {
    const registry = fakeRegistry();
    const started: number[] = [];
    const scheduler = new QueueingScheduler({ spawner: registry.spawner, pollIntervalMs: 0 });

    const spawn = (n: number) => async () => {
      started.push(n);
      registry.activeSet("proj").add(n);
    };
    for (const n of [1, 2, 3, 4]) scheduler.schedule(spawn(n), request("proj", n, 2));
    await flush();
    expect(started).toEqual([1, 2]);

    // Issue 1's worker reaches a terminal state → issue 3 spawns next (FIFO).
    registry.stopWorker("proj", 1);
    await scheduler.drain("proj");
    expect(started).toEqual([1, 2, 3]);

    registry.stopWorker("proj", 2);
    await scheduler.drain("proj");
    expect(started).toEqual([1, 2, 3, 4]);
  });

  it("polls so externally killed/stopped workers free their slot", async () => {
    const registry = fakeRegistry();
    const started: number[] = [];
    const scheduler = new QueueingScheduler({ spawner: registry.spawner, pollIntervalMs: 5 });

    const spawn = (n: number) => async () => {
      started.push(n);
      registry.activeSet("proj").add(n);
    };
    scheduler.schedule(spawn(1), request("proj", 1, 1));
    scheduler.schedule(spawn(2), request("proj", 2, 1));
    await flush();
    expect(started).toEqual([1]);

    // Worker for issue 1 is killed externally — no drain call, just the poll.
    registry.stopWorker("proj", 1);
    await sleep(40);
    expect(started).toEqual([1, 2]);

    await scheduler.drain("proj"); // flush pending drains before test end
  });

  it("counts in-flight (not yet settled) spawn tasks toward the cap", async () => {
    const registry = fakeRegistry();
    const started: number[] = [];
    const scheduler = new QueueingScheduler({ spawner: registry.spawner, pollIntervalMs: 0 });

    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let released = false;

    // Task 1 holds its slot until the gate opens; task 2 registers active immediately.
    scheduler.schedule(async () => {
      started.push(1);
      if (!released) await gate;
      registry.activeSet("proj").add(1);
    }, request("proj", 1, 2));
    scheduler.schedule(async () => {
      started.push(2);
      registry.activeSet("proj").add(2);
    }, request("proj", 2, 2));
    scheduler.schedule(async () => {
      started.push(3);
      registry.activeSet("proj").add(3);
    }, request("proj", 3, 2));

    await flush();
    // Only 2 slots: task 3 must wait even though task 1 hasn't registered a worker yet.
    expect(started).toEqual([1, 2]);

    released = true;
    releaseFirst();
    registry.stopWorker("proj", 2);
    await scheduler.drain("proj");
    expect(started).toEqual([1, 2, 3]);
  });

  it("keeps caps per project isolated", async () => {
    const registry = fakeRegistry();
    const started: string[] = [];
    const scheduler = new QueueingScheduler({ spawner: registry.spawner, pollIntervalMs: 0 });

    const spawn = (project: string, n: number) => async () => {
      started.push(`${project}#${n}`);
      registry.activeSet(project).add(n);
    };
    scheduler.schedule(spawn("a", 1), request("a", 1, 1));
    scheduler.schedule(spawn("a", 2), request("a", 2, 1));
    scheduler.schedule(spawn("b", 1), request("b", 1, 1));
    scheduler.schedule(spawn("b", 2), request("b", 2, 1));

    await flush();
    // One slot per project, used concurrently across projects.
    expect(started).toEqual(["a#1", "b#1"]);

    registry.stopWorker("a", 1);
    await scheduler.drain("a");
    expect(started).toEqual(["a#1", "b#1", "a#2"]);
  });

  it("reports task errors and keeps the queue moving", async () => {
    const registry = fakeRegistry();
    const errors: unknown[] = [];
    const started: number[] = [];
    const scheduler = new QueueingScheduler({ spawner: registry.spawner, onError: (err) => errors.push(err), pollIntervalMs: 0 });

    scheduler.schedule(async () => {
      started.push(1);
      throw new Error("spawn failed");
    }, request("proj", 1, 1));
    scheduler.schedule(async () => {
      started.push(2);
      registry.activeSet("proj").add(2);
    }, request("proj", 2, 1));

    await flush();
    expect(started).toEqual([1, 2]); // failed task freed its slot
    expect(errors).toEqual([new Error("spawn failed")]);
  });

  it("survives a failing registry query and retries on the next poll", async () => {
    const registry = fakeRegistry();
    const errors: unknown[] = [];
    const started: number[] = [];
    let failQuery = true;
    const spawner: Pick<WorkerSpawner, "listActiveWorkerIssueNumbers"> = {
      async listActiveWorkerIssueNumbers(projectId) {
        if (failQuery) throw new Error("registry down");
        return registry.spawner.listActiveWorkerIssueNumbers(projectId);
      },
    };
    const scheduler = new QueueingScheduler({ spawner, onError: (err) => errors.push(err), pollIntervalMs: 5 });

    scheduler.schedule(async () => {
      started.push(1);
      registry.activeSet("proj").add(1);
    }, request("proj", 1, 1));

    await sleep(30);
    expect(started).toEqual([]);
    expect(errors.length).toBeGreaterThanOrEqual(1); // failed attempts surfaced, queue retained

    failQuery = false;
    await sleep(30);
    expect(started).toEqual([1]);

    await scheduler.drain("proj"); // flush pending drains before test end
  });

  it("stops polling once a project's queue empties", async () => {
    const registry = fakeRegistry();
    const spawnerSpy = vi.spyOn(registry.spawner, "listActiveWorkerIssueNumbers");
    const scheduler = new QueueingScheduler({ spawner: registry.spawner, pollIntervalMs: 5 });

    scheduler.schedule(async () => {
      registry.activeSet("proj").add(1);
    }, request("proj", 1, 1));
    await flush();
    const duringQueue = spawnerSpy.mock.calls.length;
    expect(duringQueue).toBeGreaterThan(0);

    registry.stopWorker("proj", 1);
    await sleep(40); // poll drains the queue, then the timer stops
    await scheduler.drain("proj");

    const callsAtRest = spawnerSpy.mock.calls.length;
    await sleep(30);
    expect(spawnerSpy.mock.calls.length).toBe(callsAtRest); // no further registry queries for an empty queue
  });
});

/** Marks the task started and settles immediately. */
async function run(started: number[], n: number): Promise<void> {
  started.push(n);
}
