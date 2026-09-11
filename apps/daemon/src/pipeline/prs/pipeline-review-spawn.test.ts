/**
 * Review-agent spawn path env (issue #407): with a review account token,
 * the reviewer pane is started with `GH_TOKEN` of that second GitHub
 * account so its `gh pr review` calls file real reviews as that identity —
 * the primary account cannot review its own PRs. Without the token, no env
 * override happens.
 */

import { describe, expect, it } from "vitest";

import { spawnReviewAgent } from "./review-spawn.js";

function fakeSessions() {
  const spawns: Array<{ options: Record<string, unknown> }> = [];
  const statusWrites: Array<{ workerId: string; status: string; statusMessage: string }> = [];
  const worker = {
    id: "worker-reviewer-1",
    projectId: "proj",
    sessionId: "sess-reviewer-1",
    issueNumber: 0,
    prNumber: 12,
    status: "running",
    statusMessage: null,
    startedAt: "2026-09-06T12:00:00Z",
    updatedAt: "2026-09-06T12:00:00Z",
  };
  return {
    spawns,
    statusWrites,
    worker,
    sessions: {
      spawnWorker: async (_projectId: string, options: Record<string, unknown>) => {
        spawns.push({ options });
        return { worker };
      },
      deliverPromptWhenReady: async () => ({ typed: true, accepted: true }),
      updateWorkerStatus: (workerId: string, status: string, statusMessage?: string) => {
        statusWrites.push({ workerId, status, statusMessage: statusMessage ?? "" });
        worker.status = status as typeof worker.status;
        return worker;
      },
    },
  };
}

const REQUEST = { prNumber: 12, parentWorkerId: "worker-1", prompt: "review prompt" };

/** Issue #424 (F8): the readiness deps are required — both tests are on the ready path (no hold). */
const READY_DEPS = { piReady: async () => true, promptGate: { queue: () => undefined } };

describe("spawnReviewAgent env (issue #407)", () => {
  it("injects the review account token as GH_TOKEN into the reviewer pane", async () => {
    const fake = fakeSessions();
    const worker = await spawnReviewAgent("proj", REQUEST, {
      sessions: fake.sessions as never,
      broadcastSpawned: () => undefined,
      reviewGhToken: "ghp_review",
      ...READY_DEPS,
      onError: () => undefined,
    });
    expect(worker?.id).toBe("worker-reviewer-1");
    expect(fake.spawns[0]?.options).toMatchObject({ kind: "reviewer", env: { GH_TOKEN: "ghp_review" } });
  });

  it("injects nothing without a configured review account", async () => {
    const fake = fakeSessions();
    await spawnReviewAgent("proj", REQUEST, {
      sessions: fake.sessions as never,
      broadcastSpawned: () => undefined,
      reviewGhToken: null,
      ...READY_DEPS,
      onError: () => undefined,
    });
    expect(fake.spawns[0]?.options).not.toHaveProperty("env");
  });

  // Issue #501 (B9): a delivery failure after the spawn leaves the record
  // `running` with no tracker linkage — a phantom working reviewer in the
  // sidebar forever. The orphan is marked `failed` (the prompt gate's
  // never-silently-lost convention) and the error stays sunk (the pipeline
  // retries on a later poll).
  it("marks the reviewer failed when its prompt delivery throws", async () => {
    const fake = fakeSessions();
    fake.sessions.deliverPromptWhenReady = async () => {
      throw new Error("pane never accepted input");
    };
    const errors: unknown[] = [];
    const result = await spawnReviewAgent("proj", REQUEST, {
      sessions: fake.sessions as never,
      broadcastSpawned: () => undefined,
      reviewGhToken: "ghp_review",
      ...READY_DEPS,
      onError: (err) => errors.push(err),
    });
    expect(result).toBeNull(); // the pipeline's retry signal
    expect(errors).toHaveLength(1); // sunk, not thrown
    expect(fake.statusWrites).toEqual([
      { workerId: "worker-reviewer-1", status: "failed", statusMessage: "initial prompt delivery failed: pane never accepted input" },
    ]);
  });

  it("a spawn-path failure before the record exists only sinks the error", async () => {
    const fake = fakeSessions();
    fake.sessions.spawnWorker = async () => {
      throw new Error("tmux launch failed");
    };
    const errors: unknown[] = [];
    const result = await spawnReviewAgent("proj", REQUEST, {
      sessions: fake.sessions as never,
      broadcastSpawned: () => undefined,
      reviewGhToken: "ghp_review",
      ...READY_DEPS,
      onError: (err) => errors.push(err),
    });
    expect(result).toBeNull();
    expect(errors).toHaveLength(1);
    expect(fake.statusWrites).toEqual([]); // nothing to mark — no record was created
  });
});