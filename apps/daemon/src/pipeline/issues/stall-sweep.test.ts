/**
 * Stall-sweep tests (issue #467): an issue worker whose turn silently ends
 * (no PR, no prompt in flight) is re-prompted by nothing — the PR loop
 * drives tracked PRs, the prompt gate drives queued prompts, reconcile
 * resurrects dead panes only. The sweep is the deterministic backstop:
 * idle past the window → one bounded re-prompt; bound exhausted → the
 * worker is failed with a manual-intervention message.
 */

import { describe, expect, it } from "vitest";
import type { Worker } from "@pideck/shared";

import { DEFAULT_MAX_REPROMPTS, DEFAULT_STALL_IDLE_MS, StallSweep, type StallSweepDeps } from "./stall-sweep.js";

const BASE = Date.parse("2026-09-12T12:00:00.000Z");

function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: "worker-1",
    projectId: "proj",
    sessionId: "sess-1",
    issueNumber: 7,
    prNumber: null,
    status: "running",
    statusMessage: "agent running; initial prompt delivered",
    startedAt: new Date(BASE - 60 * 60_000).toISOString(),
    updatedAt: new Date(BASE - 60 * 60_000).toISOString(),
    ...overrides,
  };
}

interface Harness extends StallSweepDeps {
  workers: Worker[];
  prompts: Array<{ sessionId: string; keys: string }>;
  statusChanges: Array<{ workerId: string; status: string; statusMessage?: string }>;
  /** Advances the fake clock. */
  advance: (ms: number) => void;
  sweep(): ReturnType<StallSweep["sweep"]>;
  /** Makes the next sendKeys call throw (dead pane). */
  failNextSend(): void;
}

function harness(options: { stallIdleMs?: number; maxReprompts?: number; workers?: Worker[] } = {}): Harness {
  const workers = options.workers ?? [makeWorker()];
  const prompts: Array<{ sessionId: string; keys: string }> = [];
  const statusChanges: Array<{ workerId: string; status: string; statusMessage?: string }> = [];
  let clock = BASE;
  let failNext = false;
  const deps: StallSweepDeps = {
    listWorkers: () => workers,
    sendKeys: async (sessionId, keys) => {
      if (failNext) {
        failNext = false;
        throw new Error("tmux session gone");
      }
      prompts.push({ sessionId, keys });
    },
    updateWorkerStatus: (workerId, status, statusMessage) => {
      const worker = workers.find((w) => w.id === workerId);
      if (worker === undefined) throw new Error(`unknown worker: ${workerId}`);
      worker.status = status;
      worker.statusMessage = statusMessage ?? null;
      worker.updatedAt = new Date(clock).toISOString();
      statusChanges.push({ workerId, status, statusMessage });
      return worker;
    },
    ...(options.stallIdleMs !== undefined || options.maxReprompts !== undefined
      ? {
          ...(options.stallIdleMs !== undefined ? { stallIdleMs: options.stallIdleMs } : {}),
          ...(options.maxReprompts !== undefined ? { maxReprompts: options.maxReprompts } : {}),
        }
      : {}),
    now: () => new Date(clock),
    onError: () => {},
  };
  const sweep = new StallSweep(deps);
  return {
    ...deps,
    workers,
    prompts,
    statusChanges,
    advance: (ms) => {
      clock += ms;
    },
    sweep: () => sweep.sweep(),
    failNextSend: () => {
      failNext = true;
    },
  };
}

describe("StallSweep detection (issue #467)", () => {
  it("re-prompts an idle issue worker with no PR and resets its idle clock", async () => {
    const h = harness();
    const outcome = await h.sweep();
    expect(outcome.reprompted).toEqual(["worker-1"]);
    expect(outcome.failed).toEqual([]);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toEqual({ sessionId: "sess-1", keys: expect.stringContaining("issue #7") });
    expect(h.prompts[0]!.keys).toContain("Re-prompt 1 of 2");
    expect(h.statusChanges).toEqual([
      { workerId: "worker-1", status: "running", statusMessage: expect.stringContaining("stalled") },
    ]);
    // The status bump resets the idle clock: an immediate second sweep is quiet.
    const again = await h.sweep();
    expect(again.reprompted).toEqual([]);
    expect(h.prompts).toHaveLength(1);
  });

  it("leaves a worker inside the idle window alone", async () => {
    const h = harness({ stallIdleMs: 15 * 60_000 });
    h.workers[0]!.updatedAt = new Date(BASE - 14 * 60_000).toISOString(); // not yet stalled
    const outcome = await h.sweep();
    expect(outcome.reprompted).toEqual([]);
    expect(h.prompts).toHaveLength(0);
  });

  it("skips workers with a PR (the PR loop owns them)", async () => {
    const h = harness({ workers: [makeWorker({ prNumber: 12 })] });
    const outcome = await h.sweep();
    expect(outcome.reprompted).toEqual([]);
  });

  it("skips freeform workers (issueNumber 0) and review agents", async () => {
    const h = harness({
      workers: [makeWorker({ id: "freeform", issueNumber: 0 }), makeWorker({ id: "reviewer", kind: "reviewer" })],
    });
    const outcome = await h.sweep();
    expect(outcome.reprompted).toEqual([]);
  });

  it("skips terminal workers and gate-held (spawning) ones", async () => {
    const h = harness({
      workers: [makeWorker({ id: "done", status: "done" }), makeWorker({ id: "spawning", status: "spawning" })],
    });
    const outcome = await h.sweep();
    expect(outcome.reprompted).toEqual([]);
    expect(h.prompts).toHaveLength(0);
  });

  it("skips a worker with a prompt in flight on the gate", async () => {
    const workers = [makeWorker()];
    const prompts: Array<{ sessionId: string; keys: string }> = [];
    const sweep = new StallSweep({
      listWorkers: () => workers,
      sendKeys: async (sessionId, keys) => {
        prompts.push({ sessionId, keys });
      },
      updateWorkerStatus: (workerId, status, statusMessage) => {
        const worker = workers.find((w) => w.id === workerId)!;
        worker.status = status;
        worker.statusMessage = statusMessage ?? null;
        return worker;
      },
      promptInFlight: (workerId) => workerId === "worker-1",
      now: () => new Date(BASE),
      onError: () => {},
    });
    const outcome = await sweep.sweep();
    expect(outcome.reprompted).toEqual([]);
    expect(prompts).toHaveLength(0);
  });
});

describe("StallSweep bound (issue #467 — bounded like the fix-attempt caps)", () => {
  it("re-prompts up to the bound, then fails the worker on the next sweep", async () => {
    const h = harness({ maxReprompts: 2 });
    await h.sweep(); // attempt 1
    h.advance(20 * 60_000);
    await h.sweep(); // attempt 2
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]!.keys).toContain("Re-prompt 2 of 2");
    expect(h.workers[0]!.status).toBe("running");

    // Still no PR, no activity: the bound is exhausted — terminal, no more prompts.
    h.advance(20 * 60_000);
    const outcome = await h.sweep();
    expect(outcome.failed).toEqual(["worker-1"]);
    expect(h.prompts).toHaveLength(2);
    expect(h.workers[0]!.status).toBe("failed");
    expect(h.workers[0]!.statusMessage).toContain("manual intervention");

    // Terminal workers are never touched again.
    h.advance(20 * 60_000);
    await h.sweep();
    expect(h.prompts).toHaveLength(2);
  });

  it("resets the bound when the worker delivers a PR (progress, not stall)", async () => {
    const h = harness({ maxReprompts: 1 });
    await h.sweep(); // attempt 1 (bound 1 reached)
    h.workers[0]!.prNumber = 42; // the worker delivered
    h.advance(20 * 60_000);
    await h.sweep(); // PR loop owns it — and the streak resets
    expect(h.prompts).toHaveLength(1);
    expect(h.workers[0]!.status).toBe("running");

    // A later stall (PR closed? — any active no-PR record again) starts fresh.
    h.workers[0]!.prNumber = null;
    h.advance(20 * 60_000);
    const outcome = await h.sweep();
    expect(outcome.reprompted).toEqual(["worker-1"]); // attempt 1 of 1, not failed
    expect(h.prompts[1]!.keys).toContain("Re-prompt 1 of 1");
  });

  it("resets the bound when the worker reaches a terminal status", async () => {
    const h = harness({ maxReprompts: 1 });
    await h.sweep();
    h.workers[0]!.status = "stopped"; // pane died; reconcile marked it
    h.advance(20 * 60_000);
    await h.sweep();
    expect(h.prompts).toHaveLength(1); // never re-prompted a terminal worker

    // And a fresh stalled worker after that starts from attempt 1.
    h.workers[0]!.status = "running";
    h.workers[0]!.updatedAt = new Date(BASE - 60 * 60_000).toISOString();
    const outcome = await h.sweep();
    expect(outcome.reprompted).toEqual(["worker-1"]);
    expect(h.prompts[1]!.keys).toContain("Re-prompt 1 of 1");
  });
});

describe("StallSweep failure handling (issue #467)", () => {
  it("fails the worker when the re-prompt delivery fails (dead pane — never loops)", async () => {
    const h = harness();
    h.failNextSend();
    const outcome = await h.sweep();
    expect(outcome.reprompted).toEqual([]);
    expect(outcome.failed).toEqual(["worker-1"]);
    expect(h.workers[0]!.status).toBe("failed");
    expect(h.workers[0]!.statusMessage).toContain("delivery failed");
    // No prompt retries on a dead pane; the sweep survives the error.
    const next = await h.sweep();
    expect(next.reprompted).toEqual([]);
  });

  it("is a no-op with no workers", async () => {
    const h = harness({ workers: [] });
    const outcome = await h.sweep();
    expect(outcome).toEqual({ reprompted: [], failed: [] });
  });
});

describe("StallSweep defaults", () => {
  it("idle window is 15 minutes and the bound is 2 re-prompts", () => {
    expect(DEFAULT_STALL_IDLE_MS).toBe(15 * 60_000);
    expect(DEFAULT_MAX_REPROMPTS).toBe(2);
  });
});
