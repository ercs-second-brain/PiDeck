/**
 * Tests for {@link deliverSpawnPrompt} — the ONE shared spawn-path
 * prompt-delivery dance (issues #56/#318/#378; consolidated from four
 * drifted copies — CLI worker spawn, issue auto-spawn, review-agent spawn,
 * agent-kind session spawn — in issue #426). All dependencies are fakes;
 * the gate stub records the holds, the status map records the transitions.
 */

import { describe, expect, it } from "vitest";
import type { Worker } from "@pideck/shared";

import { deliverSpawnPrompt, type SpawnPromptGate, type SpawnPromptSessions } from "./prompt-gate.js";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";

function worker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: "worker-1",
    projectId: "o-r",
    sessionId: "sess-1",
    issueNumber: 5,
    prNumbers: [],
    status: "spawning",
    statusMessage: null,
    startedAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deliverSpawnPrompt — the ONE shared spawn-path prompt-delivery dance
// (issues #56/#318/#378; consolidated from four drifted copies, issue #426)
// ---------------------------------------------------------------------------

interface DanceHarness {
  sessions: SpawnPromptSessions;
  gate: SpawnPromptGate;
  workers: Map<string, Worker>;
  typed: Array<{ sessionId: string; text: string }>;
  queuedWorkers: Array<{ workerId: string; prompt: string | undefined }>;
  queuedSessions: Array<{ sessionId: string; prompt: string }>;
  worker: () => Worker;
  isReady: () => Promise<boolean>;
  setReady: (ready: boolean) => void;
}

/** Fakes for the dance: deliverable pane, status map, recording gate stub. */
function dance(options: { result?: { typed: boolean; accepted: boolean }; ready?: boolean } = {}): DanceHarness {
  const result = options.result ?? { typed: true, accepted: true };
  let ready = options.ready ?? true;
  const workers = new Map<string, Worker>([["worker-1", worker()]]);
  const typed: Array<{ sessionId: string; text: string }> = [];
  const queuedWorkers: Array<{ workerId: string; prompt: string | undefined }> = [];
  const queuedSessions: Array<{ sessionId: string; prompt: string }> = [];
  const sessions: SpawnPromptSessions = {
    deliverPromptWhenReady: async (sessionId, text) => {
      typed.push({ sessionId, text });
      return result;
    },
    updateWorkerStatus: (workerId, status, statusMessage) => {
      const current = workers.get(workerId);
      if (current === undefined) throw new Error(`unknown worker ${workerId}`);
      const updated = { ...current, status, ...(statusMessage !== undefined ? { statusMessage } : {}) };
      workers.set(workerId, updated);
      return updated;
    },
  };
  const gate: SpawnPromptGate = {
    queue: (gatedWorker, prompt) => void queuedWorkers.push({ workerId: gatedWorker.id, prompt }),
    queueSession: (sessionId, prompt) => void queuedSessions.push({ sessionId, prompt }),
  };
  return {
    sessions,
    gate,
    workers,
    typed,
    queuedWorkers,
    queuedSessions,
    worker: () => workers.get("worker-1") as Worker,
    isReady: () => Promise.resolve(ready),
    setReady: (value: boolean) => {
      ready = value;
    },
  };
}

describe("deliverSpawnPrompt: worker targets (issue #426 — the one shared spawn-path dance)", () => {
  it("holds a worker's prompt on the gate while pi auth is unready (issue #56)", async () => {
    const d = dance({ ready: false });
    await deliverSpawnPrompt(d.sessions, d.gate, d.isReady, { kind: "worker", worker: d.worker() }, "fix the flaky test");
    expect(d.typed).toEqual([]);
    expect(d.queuedWorkers).toEqual([{ workerId: "worker-1", prompt: "fix the flaky test" }]);
  });

  it("queues a prompt-less worker hold on the gate while unready and types nothing when ready", async () => {
    const d = dance({ ready: false });
    await deliverSpawnPrompt(d.sessions, d.gate, d.isReady, { kind: "worker", worker: d.worker() }, undefined);
    expect(d.queuedWorkers).toEqual([{ workerId: "worker-1", prompt: undefined }]);
    expect(d.typed).toEqual([]);

    const d2 = dance({ ready: true });
    await deliverSpawnPrompt(d2.sessions, d2.gate, d2.isReady, { kind: "worker", worker: d2.worker() }, undefined);
    expect(d2.typed).toEqual([]);
    expect(d2.queuedWorkers).toEqual([]);
    expect(d2.worker().status).toBe("spawning"); // untouched
  });

  it("delivers when ready and flips the worker running with the converged status strings", async () => {
    const d = dance();
    await deliverSpawnPrompt(d.sessions, d.gate, d.isReady, { kind: "worker", worker: d.worker() }, "fix the flaky test");
    expect(d.typed).toEqual([{ sessionId: "sess-1", text: "fix the flaky test" }]);
    expect(d.worker()).toMatchObject({ status: "running", statusMessage: "agent running; initial prompt delivered" });
    expect(d.queuedWorkers).toEqual([]);
  });

  it("typed-but-unconfirmed drafts are never queued (double delivery) — running with the truthful message", async () => {
    const d = dance({ result: { typed: true, accepted: false } });
    await deliverSpawnPrompt(d.sessions, d.gate, d.isReady, { kind: "worker", worker: d.worker() }, "fix the flaky test");
    expect(d.worker()).toMatchObject({ status: "running", statusMessage: "agent running; initial prompt typed (submit unconfirmed)" });
    expect(d.queuedWorkers).toEqual([]);
  });

  it("a pane that never readies queues the prompt on the gate for a retried delivery (#318)", async () => {
    const d = dance({ result: { typed: false, accepted: false } });
    await deliverSpawnPrompt(d.sessions, d.gate, d.isReady, { kind: "worker", worker: d.worker() }, "fix the flaky test");
    expect(d.worker().status).toBe("spawning"); // never a false `running`
    expect(d.queuedWorkers).toEqual([{ workerId: "worker-1", prompt: "fix the flaky test" }]);
  });

  it("an absent piReady probe = assume ready (the tests/legacy branch)", async () => {
    const d = dance();
    await deliverSpawnPrompt(d.sessions, d.gate, undefined, { kind: "worker", worker: d.worker() }, "fix the flaky test");
    expect(d.typed).toHaveLength(1);
    expect(d.worker().status).toBe("running");
  });

  it("a gate-less unready spawn delivers anyway (the legacy no-gate branch)", async () => {
    const d = dance({ ready: false });
    await deliverSpawnPrompt(d.sessions, undefined, d.isReady, { kind: "worker", worker: d.worker() }, "fix the flaky test");
    expect(d.typed).toEqual([{ sessionId: "sess-1", text: "fix the flaky test" }]);
    expect(d.worker()).toMatchObject({ status: "running", statusMessage: "agent running; initial prompt delivered" });
  });
});

describe("deliverSpawnPrompt: sessions and error handling (issue #426)", () => {
  it("session targets queue on the gate (silently) and never touch worker status", async () => {
    const d = dance({ ready: false });
    await deliverSpawnPrompt(d.sessions, d.gate, d.isReady, { kind: "session", sessionId: "sess-kind-1" }, "why is spawn slow?");
    expect(d.queuedSessions).toEqual([{ sessionId: "sess-kind-1", prompt: "why is spawn slow?" }]);
    expect(d.queuedWorkers).toEqual([]);
    expect(d.worker().status).toBe("spawning"); // sessions have no worker status

    const d2 = dance({ result: { typed: false, accepted: false } });
    await deliverSpawnPrompt(d2.sessions, d2.gate, d2.isReady, { kind: "session", sessionId: "sess-kind-1" }, "why is spawn slow?");
    expect(d2.queuedSessions).toEqual([{ sessionId: "sess-kind-1", prompt: "why is spawn slow?" }]);
  });

  it("errors propagate without labels.onError (awaited HTTP routes fail the request)", async () => {
    const d = dance();
    const failing: SpawnPromptSessions = {
      ...d.sessions,
      deliverPromptWhenReady: async () => {
        throw new Error("pane exploded");
      },
    };
    await expect(
      deliverSpawnPrompt(failing, d.gate, d.isReady, { kind: "worker", worker: d.worker() }, "fix the flaky test"),
    ).rejects.toThrow("pane exploded");
  });

  it("errors sink when labels.onError is set (the background pipeline paths)", async () => {
    const d = dance();
    const errors: unknown[] = [];
    const failing: SpawnPromptSessions = {
      ...d.sessions,
      deliverPromptWhenReady: async () => {
        throw new Error("pane exploded");
      },
    };
    await deliverSpawnPrompt(failing, d.gate, d.isReady, { kind: "worker", worker: d.worker() }, "fix the flaky test", {
      onError: (err) => errors.push(err),
    });
    expect(errors).toEqual([new Error("pane exploded")]);
  });
});
