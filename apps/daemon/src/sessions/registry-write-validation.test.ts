/**
 * Write-time validation tests (issue #494): the registry loader drops
 * persisted records that fail their schema — loudly, with dangling-pointer
 * repair (issue #489) — but that only fires at boot, after the bad record
 * was already persisted. The write paths must reject the same shapes at
 * spawn/persist time instead, so the file on disk never contains a record
 * the loader will have to drop. The schemas themselves are untouched
 * (forward compatibility stays loader-side).
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkerStatus } from "@pideck/shared";
import { SessionRegistry, type RegisterWorkerInput } from "./registry.js";

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pideck-registry-write-"));
  filePath = path.join(dir, "sessions.json");
});

describe("SessionRegistry: write-time validation (issue #494)", () => {
  it("fails a schema-invalid worker record at registration instead of persisting it", () => {
    const registry = new SessionRegistry(filePath);
    const session = registry.createSession({ projectId: "a", role: "worker", tmuxSession: "pideck-a-worker-1" });
    // Unvalidated caller junk (a string issueNumber from an unchecked spawn
    // route) fails the worker schema — exactly the shape the loader would
    // silently drop at boot, leaving a dangling session.workerId (#488).
    expect(() =>
      registry.registerWorker({ projectId: "a", sessionId: session.id, issueNumber: "7" } as unknown as RegisterWorkerInput),
    ).toThrow(/refusing to write invalid worker record/);
    // Nothing was committed: not in memory, not on disk.
    expect(registry.listWorkers()).toHaveLength(0);
    const state = JSON.parse(readFileSync(filePath, "utf8")) as { workers: unknown[] };
    expect(state.workers).toHaveLength(0);
  });

  it("fails an empty prompt at registration (the loader would drop the record)", () => {
    const registry = new SessionRegistry(filePath);
    const session = registry.createSession({ projectId: "a", role: "worker", tmuxSession: "pideck-a-worker-1" });
    expect(() => registry.registerWorker({ projectId: "a", sessionId: session.id, issueNumber: 1, prompt: "" })).toThrow(
      /refusing to write invalid worker record/,
    );
    expect(registry.listWorkers()).toHaveLength(0);
  });

  it("fails a schema-invalid session record at creation instead of persisting it", () => {
    const registry = new SessionRegistry(filePath);
    const good = registry.createSession({ projectId: "a", role: "worker", tmuxSession: "pideck-a-worker-1" });
    // A >20-char sidebar label fails the session schema.
    expect(() =>
      registry.createSession({ projectId: "a", role: "worker", tmuxSession: "pideck-a-worker-2", name: "this-label-is-way-too-long" }),
    ).toThrow(/refusing to write invalid session record/);
    expect(registry.listSessions()).toHaveLength(1);
    const state = JSON.parse(readFileSync(filePath, "utf8")) as { sessions: Array<{ id: string }> };
    expect(state.sessions.map((s) => s.id)).toEqual([good.id]);
  });

  it("fails loudly at persist when an in-memory record no longer matches the schema", () => {
    const registry = new SessionRegistry(filePath);
    const session = registry.createSession({ projectId: "a", role: "worker", tmuxSession: "pideck-a-worker-1" });
    const worker = registry.registerWorker({ projectId: "a", sessionId: session.id, issueNumber: 1 });
    registry.setSessionWorker(session.id, worker.id);

    // Simulate an in-memory corruption (a future write-path bug): the
    // record handed out by getWorker is the live map entry.
    const live = registry.getWorker(worker.id);
    if (!live) throw new Error("worker disappeared");
    live.status = "not-a-status" as WorkerStatus;

    expect(() => registry.setWorkerPr(worker.id, 12)).toThrow(/refusing to write invalid worker record/);
    // The disk keeps the last-good state — the loader never sees the bad shape.
    const state = JSON.parse(readFileSync(filePath, "utf8")) as {
      workers: Array<{ id: string; status: string; prNumbers: number[] }>;
    };
    expect(state.workers.find((w) => w.id === worker.id)).toMatchObject({ status: "spawning", prNumbers: [] });
  });

  it("a rejected write never poisons later ones", () => {
    const registry = new SessionRegistry(filePath);
    const session = registry.createSession({ projectId: "a", role: "worker", tmuxSession: "pideck-a-worker-1" });
    expect(() =>
      registry.registerWorker({ projectId: "a", sessionId: session.id, issueNumber: "7" } as unknown as RegisterWorkerInput),
    ).toThrow(/refusing to write invalid worker record/);

    // The rejected record never entered the map: subsequent valid writes
    // succeed and the reload sees exactly the good record.
    const good = registry.registerWorker({ projectId: "a", sessionId: session.id, issueNumber: 2 });
    registry.setSessionWorker(session.id, good.id);
    const reloaded = new SessionRegistry(filePath);
    expect(reloaded.listWorkers()).toHaveLength(1);
    expect(reloaded.getSession(session.id)?.workerId).toBe(good.id);
  });
});