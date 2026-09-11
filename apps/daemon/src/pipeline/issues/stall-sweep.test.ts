/**
 * Stall backstop tests (issue #467): the deterministic sweep re-prompts
 * (bounded) non-terminal issue workers whose turn silently ended without a
 * PR and with no prompt in flight, emits the exhaustion notification once,
 * and never touches freeform workers, PR-owning workers, reviewers, or
 * workers with a prompt held on the gate.
 */

import { describe, expect, it } from "vitest";
import { notificationEventSchema, type Worker, type WorkerStatus } from "@pideck/shared";

import { buildStallRePromptPrompt, DEFAULT_MAX_STALL_RE_PROMPTS, DEFAULT_STALL_THRESHOLD_MS, StallSweep } from "./stall-sweep.js";

const NOW = new Date("2026-09-06T12:00:00Z");
const ISO_NOW = "2026-09-06T12:00:00.000Z";

/** A fake worker record; `updatedAt` is the staleness proxy the sweep reads. */
function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: "worker-1",
    projectId: "proj-1",
    sessionId: "sess-1",
    issueNumber: 42,
    prNumber: null,
    status: "running",
    statusMessage: "agent running; initial prompt delivered",
    startedAt: "2026-09-06T11:00:00Z",
    updatedAt: "2026-09-06T11:00:00Z",
    ...overrides,
  };
}

interface Harness {
  sweep: StallSweep;
  workers: Map<string, Worker>;
  sent: Array<{ sessionId: string; keys: string; enter?: boolean }>;
  statuses: Array<{ workerId: string; status: WorkerStatus; statusMessage?: string }>;
  errors: unknown[];
}

function makeHarness(workerList: Worker[], overrides: Partial<ConstructorParameters<typeof StallSweep>[0]> = {}): Harness {
  const workers = new Map(workerList.map((w) => [w.id, w]));
  const h: Harness = { workers, sent: [], statuses: [], errors: [], sweep: undefined as never };
  h.sweep = new StallSweep({
    listWorkers: () => [...workers.values()],
    hasPromptInFlight: () => false,
    sendKeys: async (sessionId, keys, options) => {
      h.sent.push({ sessionId, keys, ...options });
    },
    updateWorkerStatus: (workerId, status, statusMessage) => {
      const worker = workers.get(workerId);
      if (worker === undefined) throw new Error(`unknown worker ${workerId}`);
      worker.status = status;
      worker.statusMessage = statusMessage ?? worker.statusMessage;
      worker.updatedAt = ISO_NOW;
      h.statuses.push({ workerId, status, statusMessage });
      return worker;
    },
    now: () => NOW,
    onError: (err) => h.errors.push(err),
    ...overrides,
  });
  return h;
}

describe("isStalled eligibility (issue #467)", () => {
  it("re-prompts a running issue worker with no PR whose record went stale", async () => {
    const h = makeHarness([makeWorker()]);
    const events = await h.sweep.sweep("proj-1");
    expect(h.sent).toEqual([{ sessionId: "sess-1", keys: buildStallRePromptPrompt(42), enter: true }]);
    expect(events).toEqual([]);
    expect(h.statuses).toEqual([
      {
        workerId: "worker-1",
        status: "running",
        statusMessage: `stall backstop: turn ended without a PR for issue #42 — re-prompted (1/${DEFAULT_MAX_STALL_RE_PROMPTS}, issue #467)`,
      },
    ]);
  });

  it("ignores a worker whose record is fresh (under the stall threshold)", async () => {
    const h = makeHarness([makeWorker({ updatedAt: ISO_NOW })]);
    await h.sweep.sweep("proj-1");
    expect(h.sent).toEqual([]);
    expect(h.statuses).toEqual([]);
  });

  it("ignores terminal, spawning, reviewer, freeform, and PR-owning workers", async () => {
    const h = makeHarness([
      makeWorker({ id: "w-done", status: "done" }),
      makeWorker({ id: "w-failed", status: "failed" }),
      makeWorker({ id: "w-archived", status: "archived" }),
      makeWorker({ id: "w-spawning", status: "spawning" }),
      makeWorker({ id: "w-reviewer", kind: "reviewer" }),
      makeWorker({ id: "w-freeform", issueNumber: 0 }),
      makeWorker({ id: "w-pr", prNumber: 7 }),
    ]);
    await h.sweep.sweep("proj-1");
    expect(h.sent).toEqual([]);
    expect(h.statuses).toEqual([]);
  });

  it("skips a worker whose prompt is held on the gate (prompt in flight)", async () => {
    const h = makeHarness([makeWorker()], { hasPromptInFlight: (workerId) => workerId === "worker-1" });
    await h.sweep.sweep("proj-1");
    expect(h.sent).toEqual([]);
    expect(h.statuses).toEqual([]);
  });

  it("respects the configured stall threshold", async () => {
    const h = makeHarness([makeWorker({ updatedAt: "2026-09-06T11:56:00Z" })], { stallThresholdMs: DEFAULT_STALL_THRESHOLD_MS });
    // 4 minutes stale: under the 15-minute default → no re-prompt.
    await h.sweep.sweep("proj-1");
    expect(h.sent).toEqual([]);
  });
});

describe("bounded re-prompts and exhaustion (issue #467)", () => {
  it("re-prompts at most once per sweep pass", async () => {
    const h = makeHarness([makeWorker()]);
    await h.sweep.sweep("proj-1");
    await h.sweep.sweep("proj-1"); // the re-prompt refreshed updatedAt → fresh again
    expect(h.sent).toHaveLength(1);
  });

  it("stops prompting and notifies exactly once after the bound is exhausted", async () => {
    // The worker never recovers: the clock advances an hour every sweep
    // pass, so each pass finds it stale again.
    const clock = { now: NOW.getTime() };
    const h = makeHarness([makeWorker()], { now: () => new Date(clock.now) });
    const events = [];
    let notifiedAt: string | undefined;
    for (let i = 0; i < DEFAULT_MAX_STALL_RE_PROMPTS + 2; i += 1) {
      clock.now += 60 * 60_000;
      const emitted = await h.sweep.sweep("proj-1");
      events.push(...emitted);
      if (emitted.length > 0 && emitted[0] !== undefined) notifiedAt = emitted[0].at;
    }
    expect(h.sent).toHaveLength(DEFAULT_MAX_STALL_RE_PROMPTS);
    expect(events).toHaveLength(1);
    const parsed = notificationEventSchema.safeParse(events[0]);
    expect(parsed.success).toBe(true);
    expect(events[0]).toEqual({
      type: "notification.worker.stalled",
      at: notifiedAt,
      projectId: "proj-1",
      workerId: "worker-1",
      issueNumber: 42,
      title: `issue #42 worker stalled: no PR after ${DEFAULT_MAX_STALL_RE_PROMPTS} stall re-prompts`,
    });
    // The exhausted worker's status message says so truthfully, once.
    const stalled = h.statuses.filter((s) => s.statusMessage?.startsWith("stalled:"));
    expect(stalled).toHaveLength(1);
    // A later sweep is a no-op (the exhaustion latch).
    clock.now += 60 * 60_000;
    expect(await h.sweep.sweep("proj-1")).toEqual([]);
    expect(h.sent).toHaveLength(DEFAULT_MAX_STALL_RE_PROMPTS);
  });

  it("resets the bound once the worker is gone or no longer a live issue worker", async () => {
    const clock = { now: NOW.getTime() };
    const h = makeHarness([makeWorker()], { now: () => new Date(clock.now) });
    for (let i = 0; i < DEFAULT_MAX_STALL_RE_PROMPTS; i += 1) {
      clock.now += 60 * 60_000;
      await h.sweep.sweep("proj-1");
    }
    // The worker opens a PR: the sweep state is pruned (the PR loop owns it now).
    h.workers.get("worker-1")!.prNumber = 9;
    clock.now += 60 * 60_000;
    await h.sweep.sweep("proj-1");
    h.workers.get("worker-1")!.prNumber = null;
    h.workers.get("worker-1")!.updatedAt = "2026-09-06T11:00:00Z"; // stale again
    clock.now += 60 * 60_000;
    const events = await h.sweep.sweep("proj-1");
    expect(events).toEqual([]); // a fresh bound: re-prompt, not exhaustion
    expect(h.sent).toHaveLength(DEFAULT_MAX_STALL_RE_PROMPTS + 1);
  });

  it("sinks a send failure without counting the attempt", async () => {
    const h = makeHarness([makeWorker()], {
      sendKeys: async () => {
        throw new Error("pane gone");
      },
    });
    await h.sweep.sweep("proj-1");
    expect(h.errors).toHaveLength(1);
    expect(h.statuses).toEqual([]); // no attempt counted, no status churn
    // And the next sweep retries from a fresh record.
    const h2 = makeHarness([makeWorker()]);
    await h2.sweep.sweep("proj-1");
    expect(h2.sent).toHaveLength(1);
  });
});

describe("prompt shape", () => {
  it("builds a single-line pane-safe prompt", () => {
    const prompt = buildStallRePromptPrompt(42);
    expect(prompt).not.toContain("\n");
    expect(prompt).toContain("Stall backstop");
    expect(prompt).toContain("Closes #42");
  });
});