import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionRegistry } from "./registry.js";

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "agentskiss-registry-"));
  filePath = path.join(dir, "sessions.json");
});

describe("SessionRegistry", () => {
  it("creates sessions with generated ids and timestamps", () => {
    const registry = new SessionRegistry(filePath);
    const session = registry.createSession({
      projectId: "proj",
      role: "orchestrator",
      tmuxSession: "agentskiss-proj-orchestrator-1",
    });
    expect(session.id).toMatch(/^sess-/);
    expect(session.workerId).toBeNull();
    expect(new Date(session.createdAt).getTime()).not.toBeNaN();

    const worker = registry.createSession({
      projectId: "proj",
      role: "worker",
      tmuxSession: "agentskiss-proj-worker-1",
      workerId: null,
    });
    expect(worker.role).toBe("worker");
  });

  it("filters sessions by project, role, and workerId", () => {
    const registry = new SessionRegistry(filePath);
    const orch = registry.createSession({
      projectId: "a",
      role: "orchestrator",
      tmuxSession: "agentskiss-a-orchestrator-1",
    });
    const workerSession = registry.createSession({
      projectId: "a",
      role: "worker",
      tmuxSession: "agentskiss-a-worker-1",
    });
    registry.createSession({
      projectId: "b",
      role: "worker",
      tmuxSession: "agentskiss-b-worker-1",
    });

    expect(registry.listSessions({ projectId: "a" })).toHaveLength(2);
    expect(registry.listSessions({ projectId: "a", role: "worker" })).toHaveLength(1);
    expect(registry.listSessions({ workerId: null })).toHaveLength(3);
    registry.setSessionWorker(workerSession.id, "worker-1");
    expect(registry.listSessions({ workerId: "worker-1" })).toEqual([workerSession]);
    expect(registry.listSessions({ projectId: "a", workerId: null })).toEqual([orch]);
  });

  it("looks up sessions by tmux name", () => {
    const registry = new SessionRegistry(filePath);
    const session = registry.createSession({
      projectId: "a",
      role: "worker",
      tmuxSession: "agentskiss-a-worker-2",
    });
    expect(registry.getSessionByTmuxName("agentskiss-a-worker-2")?.id).toBe(session.id);
    expect(registry.getSessionByTmuxName("missing")).toBeUndefined();
  });

  it("registers workers and updates status/pr", () => {
    const registry = new SessionRegistry(filePath);
    const session = registry.createSession({
      projectId: "a",
      role: "worker",
      tmuxSession: "agentskiss-a-worker-1",
    });
    const worker = registry.registerWorker({
      projectId: "a",
      sessionId: session.id,
      issueNumber: 4,
      status: "spawning",
      statusMessage: "launching",
    });
    expect(worker.id).toMatch(/^worker-/);
    expect(worker.prNumber).toBeNull();
    expect(worker.status).toBe("spawning");

    registry.updateWorkerStatus(worker.id, "running", "up");
    registry.setWorkerPr(worker.id, 12);
    const updated = registry.getWorker(worker.id);
    if (!updated) throw new Error("worker disappeared");
    expect(updated.status).toBe("running");
    expect(updated.statusMessage).toBe("up");
    expect(updated.prNumber).toBe(12);
    expect(updated.updatedAt >= worker.startedAt).toBe(true);

    expect(registry.listWorkers({ projectId: "a", status: "running" })).toHaveLength(1);
    expect(registry.listWorkers({ status: "failed" })).toHaveLength(0);
  });

  it("persists optional cwd/command on session records (issue #27)", () => {
    const registry = new SessionRegistry(filePath);
    const withOverrides = registry.createSession({
      projectId: "a",
      role: "worker",
      tmuxSession: "agentskiss-a-worker-1",
      cwd: "/tmp/worktrees/issue-7",
      command: "bash -c 'sleep 300'",
    });
    registry.createSession({
      projectId: "a",
      role: "orchestrator",
      tmuxSession: "agentskiss-a-orchestrator-1",
    });

    // The fields land in the JSON file...
    const state = JSON.parse(readFileSync(filePath, "utf8")) as {
      sessions: { id: string; cwd?: string; command?: string }[];
    };
    const stored = state.sessions.find((s) => s.id === withOverrides.id);
    expect(stored?.cwd).toBe("/tmp/worktrees/issue-7");
    expect(stored?.command).toBe("bash -c 'sleep 300'");

    // ...and survive a reload. Records without the fields stay fieldless.
    const reloaded = new SessionRegistry(filePath);
    expect(reloaded.getSession(withOverrides.id)?.cwd).toBe("/tmp/worktrees/issue-7");
    expect(reloaded.getSession(withOverrides.id)?.command).toBe("bash -c 'sleep 300'");
    const [legacy] = reloaded
      .listSessions({ role: "orchestrator" })
      .map((s) => reloaded.getSession(s.id));
    expect(legacy?.cwd).toBeUndefined();
    expect(legacy?.command).toBeUndefined();
  });

  it("survives an in-process reload (new instance over the same file)", () => {
    const registry = new SessionRegistry(filePath);
    const session = registry.createSession({
      projectId: "a",
      role: "orchestrator",
      tmuxSession: "agentskiss-a-orchestrator-1",
    });
    const worker = registry.registerWorker({
      projectId: "a",
      sessionId: session.id,
      issueNumber: 4,
    });
    registry.setSessionWorker(session.id, worker.id);
    registry.updateWorkerStatus(worker.id, "running", "up");

    const reloaded = new SessionRegistry(filePath);
    expect(reloaded.getSession(session.id)).toEqual(registry.getSession(session.id));
    expect(reloaded.getWorker(worker.id)?.status).toBe("running");
    expect(reloaded.listSessions()).toHaveLength(1);
    expect(reloaded.listWorkers()).toHaveLength(1);
  });

  it("reload() re-reads the file into the same instance", () => {
    const first = new SessionRegistry(filePath);
    const session = first.createSession({
      projectId: "a",
      role: "worker",
      tmuxSession: "agentskiss-a-worker-1",
    });

    const second = new SessionRegistry(filePath);
    second.updateWorkerStatus(
      second.registerWorker({ projectId: "a", sessionId: session.id, issueNumber: 1 }).id,
      "running",
    );

    first.load();
    expect(first.listWorkers()).toHaveLength(1);
    expect(first.listWorkers()[0]?.status).toBe("running");
  });

  it("skips invalid records when loading", () => {
    const registry = new SessionRegistry(filePath);
    registry.createSession({
      projectId: "a",
      role: "worker",
      tmuxSession: "agentskiss-a-worker-1",
    });

    const state = JSON.parse(readFileSync(filePath, "utf8")) as {
      sessions: object[];
      workers: object[];
    };
    state.sessions.push({ id: "bogus", role: "not-a-role" });
    writeFileSync(filePath, JSON.stringify(state));

    const reloaded = new SessionRegistry(filePath);
    expect(reloaded.listSessions()).toHaveLength(1);
    expect(reloaded.listSessions()[0]?.projectId).toBe("a");
  });

  it("starts empty for a missing or corrupt file", () => {
    writeFileSync(filePath, "{not json");
    const registry = new SessionRegistry(filePath);
    expect(registry.listSessions()).toEqual([]);
    expect(registry.listWorkers()).toEqual([]);
  });

  it("deletes sessions", () => {
    const registry = new SessionRegistry(filePath);
    const session = registry.createSession({
      projectId: "a",
      role: "worker",
      tmuxSession: "agentskiss-a-worker-1",
    });
    expect(registry.deleteSession(session.id)).toBe(true);
    expect(registry.getSession(session.id)).toBeUndefined();
    expect(registry.deleteSession(session.id)).toBe(false);
  });
});

describe("SessionRegistry: reviewer linkage (issue #107)", () => {
  it("records reviewer-kind workers with pr and parent linkage", () => {
    const registry = new SessionRegistry(filePath);
    const session = registry.createSession({ projectId: "a", role: "worker", tmuxSession: "agentskiss-a-worker-1" });
    const reviewer = registry.registerWorker({
      projectId: "a",
      sessionId: session.id,
      issueNumber: 0,
      prNumber: 12,
      kind: "reviewer",
      parentWorkerId: "worker-1",
      status: "running",
    });
    expect(reviewer).toMatchObject({ prNumber: 12, kind: "reviewer", parentWorkerId: "worker-1" });

    // The linkage survives a reload (persistence round-trip).
    const reloaded = new SessionRegistry(filePath);
    expect(reloaded.getWorker(reviewer.id)).toMatchObject({ kind: "reviewer", parentWorkerId: "worker-1" });

    // Sibling spawns (no parent) leave the field absent; implementers stay unmarked.
    const sibling = registry.registerWorker({ projectId: "a", sessionId: session.id, issueNumber: 1 });
    expect(sibling.kind).toBeUndefined();
    expect(sibling.parentWorkerId).toBeUndefined();
  });
});
