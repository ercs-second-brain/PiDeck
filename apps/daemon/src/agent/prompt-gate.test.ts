/**
 * Tests for the initial-prompt readiness gate (issue #56): an unauthenticated
 * spawn must keep its prompt queued and its status truthful; once pi auth is
 * ready the queued prompt is delivered and the worker moves to `running`.
 * All tmux/pi dependencies are fakes.
 */

import { describe, expect, it, vi } from "vitest";
import type { Worker } from "@pideck/shared";

import { PromptGate, type PromptGateDeps } from "./prompt-gate.js";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";

function worker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: "worker-1",
    projectId: "o-r",
    sessionId: "sess-1",
    issueNumber: 5,
    prNumber: null,
    status: "spawning",
    statusMessage: null,
    startedAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

interface Harness {
  gate: PromptGate;
  workers: Map<string, Worker>;
  typed: Array<{ sessionId: string; keys: string; enter: boolean }>;
  setReady: (ready: boolean) => void;
}

/** Builds a gate over in-memory worker records and a fake pane (sendKeys log). */
function harness(options: Partial<PromptGateDeps> = {}): Harness {
  const workers = new Map<string, Worker>([["worker-1", worker()]]);
  const typed: Array<{ sessionId: string; keys: string; enter: boolean }> = [];
  let ready = false;
  const deps: PromptGateDeps = {
    sendKeys: async (sessionId, keys, sendOptions) => {
      typed.push({ sessionId, keys, enter: sendOptions?.enter ?? false });
    },
    getWorker: (workerId) => workers.get(workerId),
    updateWorkerStatus: (workerId, status, statusMessage) => {
      const current = workers.get(workerId);
      if (current === undefined) throw new Error(`unknown worker ${workerId}`);
      const updated = { ...current, status, ...(statusMessage !== undefined ? { statusMessage } : {}) };
      workers.set(workerId, updated);
      return updated;
    },
    isReady: async () => ready,
    ...options,
  };
  return { gate: new PromptGate(deps), workers, typed, setReady: (value: boolean) => (ready = value) };
}

describe("PromptGate.queue", () => {
  it("holds the worker at a truthful spawning status with the fix in statusMessage", () => {
    const h = harness();
    h.gate.queue(h.workers.get("worker-1") as Worker, "fix the flaky test");
    const held = h.workers.get("worker-1") as Worker;
    expect(held.status).toBe("spawning");
    expect(held.statusMessage).toContain("waiting for pi auth");
    expect(held.statusMessage).toContain("pideck onboard");
    expect(held.statusMessage).toContain("initial prompt queued");
    expect(h.gate.size).toBe(1);
  });

  it("queueing the same worker twice is idempotent", () => {
    const h = harness();
    const w = h.workers.get("worker-1") as Worker;
    h.gate.queue(w, "a");
    h.gate.queue(w, "b");
    expect(h.gate.size).toBe(1);
  });

  it("holdsWorker reports the prompt-in-flight state (issue #467 stall sweep)", () => {
    const h = harness();
    expect(h.gate.holdsWorker("worker-1")).toBe(false);
    h.gate.queue(h.workers.get("worker-1") as Worker, "a");
    expect(h.gate.holdsWorker("worker-1")).toBe(true);
    expect(h.gate.holdsWorker("worker-2")).toBe(false);
  });
});

describe("PromptGate.deliverPending", () => {
  it("keeps the prompt queued while pi auth is not ready", async () => {
    const h = harness();
    h.gate.queue(h.workers.get("worker-1") as Worker, "fix the flaky test");
    await h.gate.deliverPending();
    expect(h.typed).toEqual([]);
    expect(h.gate.size).toBe(1);
    expect((h.workers.get("worker-1") as Worker).status).toBe("spawning");
  });

  it("delivers the queued prompt once auth is ready and marks the worker running", async () => {
    const h = harness();
    h.gate.queue(h.workers.get("worker-1") as Worker, "fix the flaky test");
    h.setReady(true);
    await h.gate.deliverPending();
    expect(h.typed).toEqual([{ sessionId: "sess-1", keys: "fix the flaky test", enter: true }]);
    expect(h.gate.size).toBe(0);
    const running = h.workers.get("worker-1") as Worker;
    expect(running.status).toBe("running");
    expect(running.statusMessage).toContain("initial prompt delivered");
  });

  it("delivers prompt-less (issue-backed) holds without typing anything", async () => {
    const h = harness();
    h.gate.queue(h.workers.get("worker-1") as Worker, undefined);
    expect((h.workers.get("worker-1") as Worker).statusMessage).toContain("waiting for pi auth");
    h.setReady(true);
    await h.gate.deliverPending();
    expect(h.typed).toEqual([]);
    const running = h.workers.get("worker-1") as Worker;
    expect(running.status).toBe("running");
    expect(running.statusMessage).toBe("agent running in tmux session");
  });

  it("drops entries whose worker reached a terminal state while queued", async () => {
    const h = harness();
    h.gate.queue(h.workers.get("worker-1") as Worker, "fix the flaky test");
    h.workers.set("worker-1", worker({ status: "stopped", statusMessage: "tmux session killed" }));
    h.setReady(true);
    await h.gate.deliverPending();
    expect(h.typed).toEqual([]);
    expect(h.gate.size).toBe(0);
    expect((h.workers.get("worker-1") as Worker).status).toBe("stopped");
  });

  it("marks the worker failed (never silently loses the prompt) when delivery throws", async () => {
    const errors: unknown[] = [];
    const h = harness({
      sendKeys: async () => {
        throw new Error("can't find session");
      },
      onError: (err) => errors.push(err),
    });
    h.gate.queue(h.workers.get("worker-1") as Worker, "fix the flaky test");
    h.setReady(true);
    await h.gate.deliverPending();
    expect(h.gate.size).toBe(0);
    const failed = h.workers.get("worker-1") as Worker;
    expect(failed.status).toBe("failed");
    expect(failed.statusMessage).toContain("initial prompt delivery failed");
    expect(failed.statusMessage).toContain("can't find session");
  });

  it("serializes concurrent passes", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const h = harness({
      sendKeys: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
    });
    h.setReady(true);
    h.gate.queue(h.workers.get("worker-1") as Worker, "fix the flaky test");
    await Promise.all([h.gate.deliverPending(), h.gate.deliverPending()]);
    expect(maxInFlight).toBe(1);
    expect(h.gate.size).toBe(0);
  });

  it("delivers automatically on the poll timer once auth becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ pollIntervalMs: 5_000 });
      h.gate.queue(h.workers.get("worker-1") as Worker, "fix the flaky test");
      h.setReady(true);
      await vi.advanceTimersByTimeAsync(5_100);
      expect(h.typed).toHaveLength(1);
      expect((h.workers.get("worker-1") as Worker).status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the poll timer on stop() without clearing the queue", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ pollIntervalMs: 5_000 });
      h.gate.queue(h.workers.get("worker-1") as Worker, "fix the flaky test");
      h.gate.stop();
      h.setReady(true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.typed).toEqual([]);
      expect(h.gate.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PromptGate.queueSession (agent-kind sessions, docs/agent-kinds.md)", () => {
  it("holds the question while auth is unready, delivers once ready, and is idempotent", async () => {
    const h = harness();
    h.gate.queueSession("sess-kind-1", "why is spawn slow?");
    h.gate.queueSession("sess-kind-1", "why is spawn slow?"); // idempotent per session
    expect(h.gate.sessionSize).toBe(1);
    expect(h.gate.size).toBe(0); // worker and session queues stay separate

    await h.gate.deliverPending();
    expect(h.typed).toEqual([]); // never typed into an agent that cannot run

    h.setReady(true);
    await h.gate.deliverPending();
    expect(h.typed).toEqual([{ sessionId: "sess-kind-1", keys: "why is spawn slow?", enter: true }]);
    expect(h.gate.sessionSize).toBe(0);

    // Delivered entries are dropped: a second pass re-delivers nothing.
    await h.gate.deliverPending();
    expect(h.typed).toHaveLength(1);
  });

  it("drops the entry loudly when the pane rejects the delivery (the question can never be answered)", async () => {
    const onError = vi.fn();
    const h = harness({
      sendKeys: async () => {
        throw new Error("pane sess-dead-1 is gone");
      },
      onError,
    });
    h.gate.queueSession("sess-dead-1", "q");
    h.setReady(true);
    await h.gate.deliverPending();
    // The pane is gone: the entry is dropped (no infinite retry) and the
    // failure surfaces through the error sink instead of a worker status.
    expect(h.gate.sessionSize).toBe(0);
    expect(h.typed).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("sess-dead-1") }));
  });

  it("keeps retrying session entries across passes while auth stays unready", async () => {
    const h = harness();
    h.gate.queueSession("sess-kind-2", "q2");
    await h.gate.deliverPending();
    await h.gate.deliverPending();
    expect(h.gate.sessionSize).toBe(1);
    expect(h.typed).toEqual([]);
  });

  it("delivers worker and session entries in one pass over the single queue (issue #395)", async () => {
    const h = harness();
    h.gate.queue(h.workers.get("worker-1") as Worker, "w prompt");
    h.gate.queueSession("sess-kind-3", "s prompt");
    h.setReady(true);
    await h.gate.deliverPending();
    expect(h.typed).toEqual([
      { sessionId: "sess-1", keys: "w prompt", enter: true },
      { sessionId: "sess-kind-3", keys: "s prompt", enter: true },
    ]);
    expect(h.gate.size).toBe(0);
    expect(h.gate.sessionSize).toBe(0);
    expect((h.workers.get("worker-1") as Worker).status).toBe("running");
  });
});
