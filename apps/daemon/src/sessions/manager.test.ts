import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectLayout } from "./layout.js";
import { SessionManagerSpawner } from "../pipeline/issues/ports.js";
import {
  SessionManager,
  RESURRECT_WORKER_COMMAND,
  deserializeCommand,
  parseTmuxSessionName,
  resurrectionCommand,
  sanitizeTmuxSegment,
  serializeCommand,
} from "./manager.js";
import { SessionRegistry } from "./registry.js";
import { FakeTmuxRunner } from "./testing/fake-tmux.js";
import { Tmux, TmuxError } from "./tmux.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "agentskiss-manager-"));
});

function makeManager(): {
  manager: SessionManager;
  fake: FakeTmuxRunner;
  registry: SessionRegistry;
  layout: ProjectLayout;
} {
  const fake = new FakeTmuxRunner();
  const tmux = new Tmux({ runner: (args) => fake.run(args) });
  const layout = new ProjectLayout(stateDir);
  const registry = new SessionRegistry(layout.sessionsFilePath());
  return { manager: new SessionManager({ tmux, registry, layout }), fake, registry, layout };
}

describe("sanitizeTmuxSegment", () => {
  it("strips characters tmux forbids in session names", () => {
    expect(sanitizeTmuxSegment("my.project:2")).toBe("my-project-2");
    expect(sanitizeTmuxSegment("../etc")).toBe("etc");
  });
});

describe("parseTmuxSessionName", () => {
  it("parses daemon-managed names and rejects foreign ones", () => {
    expect(parseTmuxSessionName("agentskiss-my-proj-worker-12")).toEqual({
      projectId: "my-proj",
      role: "worker",
      n: 12,
    });
    expect(parseTmuxSessionName("agentskiss-proj-orchestrator-1")).toEqual({
      projectId: "proj",
      role: "orchestrator",
      n: 1,
    });
    expect(parseTmuxSessionName("agentskiss-proj-worker-x")).toBeNull();
    expect(parseTmuxSessionName("my-personal-session")).toBeNull();
    expect(parseTmuxSessionName("agentskiss-proj-chat-1")).toBeNull();
  });
});

const fakePaneState = (command: string[], cwd: string | undefined) => ({
  command,
  cwd,
  paneLines: [] as string[],
  cols: 80,
  rows: 24,
});

describe("command serialization (issue #27)", () => {
  it("round-trips argv through the Session.command string", () => {
    const cases = [
      ["pi"],
      ["bash", "-c", "sleep 300"],
      ["pi", "--model", "gpt '5'", "--flag=x"],
      ["/usr/local/bin/agent", "run", "a b", ""],
    ];
    for (const argv of cases) {
      expect(deserializeCommand(serializeCommand(argv))).toEqual(argv);
    }
  });

  it("guards recorded commands with the reboot-resilient shell fallback", () => {
    const guarded = resurrectionCommand(["bash", "-c", "sleep 300"]);
    expect(guarded[0]).toBe("sh");
    expect(guarded[2]).toContain("command -v bash >/dev/null 2>&1 && exec bash -c 'sleep 300'");
    expect(guarded[2]).toContain('|| exec "${SHELL:-/bin/sh}"');
    // The default worker command produces the established legacy constant.
    expect(resurrectionCommand(["pi"])).toEqual(RESURRECT_WORKER_COMMAND);
  });
});

describe("SessionManager spawn cwd/command persistence (issue #27)", () => {
  it("records the launched cwd and command on the registry session and file", async () => {
    const { manager, layout } = makeManager();
    const worktree = path.join(stateDir, "worktrees", "issue-7");
    const { session } = await manager.spawnWorker("proj", {
      issueNumber: 7,
      cwd: worktree,
      command: ["bash", "-c", "sleep 300"],
    });
    const orch = await manager.ensureOrchestrator("proj");

    expect(session.cwd).toBe(worktree);
    expect(session.command).toBe("bash -c 'sleep 300'");
    expect(orch.cwd).toBe(layout.projectDir("proj"));
    expect(orch.command).toBeUndefined(); // orchestrator panes use tmux's default shell

    const onDisk = JSON.parse(readFileSync(layout.sessionsFilePath(), "utf8")) as {
      sessions: { id: string; cwd?: string; command?: string }[];
    };
    const stored = onDisk.sessions.find((s) => s.id === session.id);
    expect(stored?.cwd).toBe(worktree);
    expect(stored?.command).toBe("bash -c 'sleep 300'");
  });

  it("resurrects a worker pane from its recorded cwd and command after a reboot", async () => {
    const { manager, layout } = makeManager();
    const worktree = path.join(stateDir, "worktrees", "issue-9");
    const spawned = await manager.spawnWorker("proj", {
      issueNumber: 9,
      cwd: worktree,
      command: ["bash", "-c", "sleep 300"],
    });

    // Reboot: the tmux server is gone; only the persisted registry remains.
    const rebooted = new FakeTmuxRunner();
    const manager2 = new SessionManager({
      tmux: new Tmux({ runner: (args) => rebooted.run(args) }),
      registry: new SessionRegistry(layout.sessionsFilePath()),
      layout,
    });
    const result = await manager2.reconcile();

    expect(result.resurrected.map((s) => s.tmuxSession)).toContain(spawned.session.tmuxSession);
    const pane = rebooted.sessions.get(spawned.session.tmuxSession);
    expect(pane?.cwd).toBe(worktree);
    expect(pane?.command).toEqual(resurrectionCommand(["bash", "-c", "sleep 300"]));
    expect(manager2.getWorker(spawned.worker.id)?.status).toBe("running");
  });

  it("falls back to role defaults for legacy records without cwd/command", async () => {
    const { manager, layout } = makeManager();
    const spawned = await manager.spawnWorker("proj", { issueNumber: 1 });
    const orch = await manager.ensureOrchestrator("proj");

    // Strip the #27 fields from the persisted file to simulate records
    // written by daemons that predate cwd/command tracking.
    const filePath = layout.sessionsFilePath();
    const state = JSON.parse(readFileSync(filePath, "utf8")) as {
      sessions: Record<string, unknown>[];
    };
    for (const record of state.sessions) {
      delete record.cwd;
      delete record.command;
    }
    writeFileSync(filePath, JSON.stringify(state));

    const rebooted = new FakeTmuxRunner();
    const manager2 = new SessionManager({
      tmux: new Tmux({ runner: (args) => rebooted.run(args) }),
      registry: new SessionRegistry(filePath),
      layout,
    });
    const result = await manager2.reconcile();

    expect(result.resurrected).toHaveLength(2);
    const workerPane = rebooted.sessions.get(spawned.session.tmuxSession);
    expect(workerPane?.cwd).toBe(layout.cloneDir("proj"));
    expect(workerPane?.command).toEqual(RESURRECT_WORKER_COMMAND);
    const orchPane = rebooted.sessions.get(orch.tmuxSession);
    expect(orchPane?.cwd).toBe(layout.projectDir("proj"));
    expect(orchPane?.command).toEqual([]); // tmux default shell
  });
});

describe("SessionManager.reconcile (issue #15)", () => {
  it("re-attaches prior sessions after a daemon restart (tmux still alive)", async () => {
    const fake = new FakeTmuxRunner();
    const tmux = new Tmux({ runner: (args) => fake.run(args) });
    const layout = new ProjectLayout(stateDir);
    const registry = new SessionRegistry(layout.sessionsFilePath());
    const manager = new SessionManager({ tmux, registry, layout });
    const spawned = await manager.spawnWorker("proj", { issueNumber: 1 });
    await manager.ensureOrchestrator("proj");
    fake.sessions.set(spawned.session.tmuxSession, {
      ...fakePaneState(["pi"], layout.cloneDir("proj")),
      paneLines: ["hello from the old pane"],
    });

    // Daemon restart: fresh registry + manager over the same state dir and
    // the same, still-running tmux server.
    const registry2 = new SessionRegistry(layout.sessionsFilePath());
    const manager2 = new SessionManager({ tmux, registry: registry2, layout });
    const result = await manager2.reconcile();

    expect(result.alive.map((s) => s.tmuxSession)).toEqual(
      expect.arrayContaining([spawned.session.tmuxSession, "agentskiss-proj-orchestrator-1"]),
    );
    expect(result.resurrected).toEqual([]);
    expect(result.lost).toEqual([]);
    expect(result.adopted).toEqual([]);
    // Re-attachable: pane capture + sendKeys work through the new manager.
    expect(await manager2.capturePane(spawned.session.id)).toContain("hello from the old pane");
    await manager2.sendKeys(spawned.session.id, "hi", { enter: true });
    expect(fake.sessions.get(spawned.session.tmuxSession)?.paneLines).toContain("hi");
  });

  it("resurrects sessions after a reboot (tmux server gone)", async () => {
    const fake = new FakeTmuxRunner();
    const tmux = new Tmux({ runner: (args) => fake.run(args) });
    const layout = new ProjectLayout(stateDir);
    layout.ensureProject("proj");
    const registry = new SessionRegistry(layout.sessionsFilePath());
    const manager = new SessionManager({ tmux, registry, layout });
    const worker = await manager.spawnWorker("proj", { issueNumber: 1 });
    const orchestrator = await manager.ensureOrchestrator("proj");

    // Reboot: the tmux server is gone but sessions.json and the state dir
    // (including the project clone) survived.
    const rebooted = new FakeTmuxRunner();
    const registry2 = new SessionRegistry(layout.sessionsFilePath());
    const manager2 = new SessionManager({
      tmux: new Tmux({ runner: (args) => rebooted.run(args) }),
      registry: registry2,
      layout,
    });
    const result = await manager2.reconcile();

    expect(result.resurrected.map((s) => s.tmuxSession)).toEqual(
      expect.arrayContaining([worker.session.tmuxSession, orchestrator.tmuxSession]),
    );
    expect(result.lost).toEqual([]);
    // Worker pane is resurrected via the shell-fallback command (runs the
    // agent when it is on PATH, else an interactive shell) in the clone
    // dir; orchestrator gets a plain shell in the project dir.
    const workerPane = rebooted.sessions.get(worker.session.tmuxSession);
    expect(workerPane?.command).toEqual(RESURRECT_WORKER_COMMAND);
    expect(workerPane?.cwd).toBe(layout.cloneDir("proj"));
    const orchPane = rebooted.sessions.get(orchestrator.tmuxSession);
    expect(orchPane?.command).toEqual([]);
    expect(orchPane?.cwd).toBe(layout.projectDir("proj"));
    // Worker status is untouched (it is running again in a fresh pane).
    expect(manager2.getWorker(worker.worker.id)?.status).toBe("running");
    expect(await manager2.capturePane(worker.session.id)).toBeDefined();
  });

  it("marks workers stopped when a dead session cannot be resurrected", async () => {
    const layout = new ProjectLayout(stateDir);
    layout.ensureProject("proj");
    const registry = new SessionRegistry(layout.sessionsFilePath());
    const tmux = new Tmux({ runner: new FakeTmuxRunner().asRunner() });
    const manager = new SessionManager({ tmux, registry, layout });
    const spawned = await manager.spawnWorker("proj", { issueNumber: 1 });

    // Reboot, and tmux cannot recreate any session (e.g. the project dir
    // is gone — real tmux fails new-session when the cwd is missing).
    rmSync(layout.projectDir("proj"), { recursive: true, force: true });
    const registry2 = new SessionRegistry(layout.sessionsFilePath());
    const manager2 = new SessionManager({
      tmux: new Tmux({
        runner: (args) => {
          const cmd = args[0] === "-L" ? args[2] : args[0];
          if (cmd === "new-session") {
            return Promise.reject(
              new TmuxError("tmux new-session failed: can't change working directory", {
                args,
                exitCode: 1,
                stderr: "can't change working directory",
              }),
            );
          }
          return new FakeTmuxRunner().run(args);
        },
      }),
      registry: registry2,
      layout,
    });
    const result = await manager2.reconcile();

    expect(result.lost.map((s) => s.id)).toContain(spawned.session.id);
    expect(result.resurrected).toEqual([]);
    const worker = manager2.getWorker(spawned.worker.id);
    expect(worker?.status).toBe("stopped");
    expect(worker?.statusMessage).toContain("tmux pane died");
  });

  it("marks workers stopped without resurrecting when asked (resurrect: false)", async () => {
    const fake = new FakeTmuxRunner();
    const layout = new ProjectLayout(stateDir);
    const registry = new SessionRegistry(layout.sessionsFilePath());
    const manager = new SessionManager({
      tmux: new Tmux({ runner: (args) => fake.run(args) }),
      registry,
      layout,
    });
    const spawned = await manager.spawnWorker("proj", { issueNumber: 1 });
    fake.sessions.clear(); // pane died

    const registry2 = new SessionRegistry(layout.sessionsFilePath());
    const manager2 = new SessionManager({
      tmux: new Tmux({ runner: new FakeTmuxRunner().asRunner() }),
      registry: registry2,
      layout,
    });
    const result = await manager2.reconcile({ resurrect: false });

    expect(result.lost.map((s) => s.id)).toContain(spawned.session.id);
    expect(manager2.getWorker(spawned.worker.id)?.status).toBe("stopped");
  });

  it("adopts live daemon-named tmux sessions missing from the registry", async () => {
    const fake = new FakeTmuxRunner();
    fake.sessions.set("agentskiss-lostproj-worker-1", fakePaneState(["pi"], undefined));
    fake.sessions.set("someone-elses-session", fakePaneState(["bash"], undefined));
    const layout = new ProjectLayout(stateDir);
    const manager = new SessionManager({
      tmux: new Tmux({ runner: (args) => fake.run(args) }),
      registry: new SessionRegistry(layout.sessionsFilePath()),
      layout,
    });

    const result = await manager.reconcile({ resurrect: false });

    expect(result.adopted.map((s) => s.tmuxSession)).toEqual(["agentskiss-lostproj-worker-1"]);
    const adopted = manager.listSessions("lostproj");
    expect(adopted).toHaveLength(1);
    expect(adopted[0]?.role).toBe("worker");
    expect(adopted[0]?.workerId).toBeNull();
    // Foreign sessions are neither adopted nor killed.
    expect(manager.listSessions()).toHaveLength(1);
    expect(fake.sessions.has("someone-elses-session")).toBe(true);
  });
});

describe("SessionManager.archiveWorker (issue #64)", () => {
  it("kills the tmux session, archives the worker, and keeps the registry record", async () => {
    const { manager, fake, layout } = makeManager();
    const { session, worker } = await manager.spawnWorker("proj", { issueNumber: 7 });
    expect(fake.sessions.has(session.tmuxSession)).toBe(true);

    const archived = await manager.archiveWorker(worker.id);

    expect(archived?.status).toBe("archived");
    expect(archived?.statusMessage).toContain("terminated");
    expect(fake.sessions.has(session.tmuxSession)).toBe(false); // pane (and pi process) gone
    // History preserved: session + worker records stay in the registry.
    expect(manager.listSessions("proj").map((s) => s.id)).toContain(session.id);
    expect(manager.getWorker(worker.id)).toBeDefined();
    // And on disk, so an in-process reload keeps the archived state too.
    const reloaded = new SessionRegistry(layout.sessionsFilePath());
    expect(reloaded.getWorker(worker.id)?.status).toBe("archived");
    expect(reloaded.getSession(session.id)).toBeDefined();
  });

  it("archives cleanly when the tmux session is already dead", async () => {
    const { manager, fake } = makeManager();
    const { worker } = await manager.spawnWorker("proj", { issueNumber: 1 });
    fake.sessions.clear(); // pane died (e.g. pi exited) before the terminate

    const archived = await manager.archiveWorker(worker.id);
    expect(archived?.status).toBe("archived");
  });

  it("is idempotent: re-terminating an archived worker succeeds", async () => {
    const { manager } = makeManager();
    const { worker } = await manager.spawnWorker("proj", { issueNumber: 2 });
    await manager.archiveWorker(worker.id);
    const again = await manager.archiveWorker(worker.id);
    expect(again?.status).toBe("archived");
    expect(manager.listWorkers({ projectId: "proj", status: "archived" })).toHaveLength(1);
  });

  it("returns null for an unknown worker id", async () => {
    const { manager } = makeManager();
    expect(await manager.archiveWorker("worker-missing")).toBeNull();
  });

  it("keeps archived workers out of the active statuses (badges/concurrency)", async () => {
    const { manager } = makeManager();
    const { worker } = await manager.spawnWorker("proj", { issueNumber: 3 });
    await manager.archiveWorker(worker.id);

    expect(manager.listWorkers({ projectId: "proj", status: "running" })).toEqual([]);
    // Issue-backed double-spawn guard: the archived issue is free again.
    const spawner = new SessionManagerSpawner(manager);
    expect([...(await spawner.listActiveWorkerIssueNumbers("proj"))]).toEqual([]);
  });
});

describe("reconcile skips archived sessions (issue #64)", () => {
  it("never resurrects an archived worker after a daemon restart or reboot", async () => {
    const { manager, layout } = makeManager();
    const spawned = await manager.spawnWorker("proj", { issueNumber: 5 });
    const orchestrator = await manager.ensureOrchestrator("proj");
    await manager.archiveWorker(spawned.worker.id);

    // Reboot: the tmux server is gone; only the persisted registry remains.
    const rebooted = new FakeTmuxRunner();
    const manager2 = new SessionManager({
      tmux: new Tmux({ runner: rebooted.asRunner() }),
      registry: new SessionRegistry(layout.sessionsFilePath()),
      layout,
    });
    const result = await manager2.reconcile();

    // Orchestrator resurrects; the archived worker is skipped entirely.
    expect(result.resurrected.map((s) => s.tmuxSession)).toEqual([orchestrator.tmuxSession]);
    expect(result.alive).toEqual([]);
    expect(result.lost).toEqual([]);
    expect(rebooted.sessions.has(spawned.session.tmuxSession)).toBe(false);
    expect(manager2.getWorker(spawned.worker.id)?.status).toBe("archived");
    expect(manager2.getWorker(spawned.worker.id)?.statusMessage).toContain("terminated");
  });

  it("skips archived worker sessions even when their tmux pane is still alive", async () => {
    const { manager, fake, layout } = makeManager();
    const spawned = await manager.spawnWorker("proj", { issueNumber: 6 });
    await manager.archiveWorker(spawned.worker.id);
    // Edge: the pane outlived the archive (e.g. tmux kill raced a reboot).
    fake.sessions.set(spawned.session.tmuxSession, fakePaneState(["pi"], undefined));

    const registry2 = new SessionRegistry(layout.sessionsFilePath());
    const manager2 = new SessionManager({
      tmux: new Tmux({ runner: fake.asRunner() }),
      registry: registry2,
      layout,
    });
    const result = await manager2.reconcile();

    expect(result.alive.map((s) => s.tmuxSession)).not.toContain(spawned.session.tmuxSession);
    expect(result.resurrected).toEqual([]);
    expect(result.lost).toEqual([]);
    expect(manager2.getWorker(spawned.worker.id)?.status).toBe("archived");
  });

  it("leaves non-archived worker sessions on the established reconcile paths", async () => {
    const { manager, layout } = makeManager();
    const stopped = await manager.spawnWorker("proj", { issueNumber: 7 });
    await manager.updateWorkerStatus(stopped.worker.id, "stopped", "pane died");

    const rebooted = new FakeTmuxRunner();
    const manager2 = new SessionManager({
      tmux: new Tmux({ runner: rebooted.asRunner() }),
      registry: new SessionRegistry(layout.sessionsFilePath()),
      layout,
    });
    const result = await manager2.reconcile();

    // Only archived workers are skipped: a stopped worker still resurrects.
    expect(result.resurrected.map((s) => s.tmuxSession)).toEqual([stopped.session.tmuxSession]);
    expect(rebooted.sessions.has(stopped.session.tmuxSession)).toBe(true);
  });
});

describe("SessionManager with a fake tmux server", () => {
  it("creates a named orchestrator session per project, once", async () => {
    const { manager, fake } = makeManager();
    const session = await manager.ensureOrchestrator("proj");

    expect(session.role).toBe("orchestrator");
    expect(session.tmuxSession).toBe("agentskiss-proj-orchestrator-1");
    expect(session.workerId).toBeNull();
    expect(fake.sessions.has("agentskiss-proj-orchestrator-1")).toBe(true);

    // Second call is a no-op while the tmux session is alive.
    const again = await manager.ensureOrchestrator("proj");
    expect(again.id).toBe(session.id);
    expect(fake.sessions.size).toBe(1);
  });

  it("creates a replacement orchestrator when the tmux session died", async () => {
    const { manager, fake, registry } = makeManager();
    const first = await manager.ensureOrchestrator("proj");
    fake.sessions.delete(first.tmuxSession); // simulate external kill

    const second = await manager.ensureOrchestrator("proj");
    expect(second.id).not.toBe(first.id);
    expect(second.tmuxSession).toBe("agentskiss-proj-orchestrator-2");
    expect(registry.getSession(first.id)).toBeDefined(); // stale record kept for audit
  });

  it("spawns a worker running pi in the project clone dir and registers it", async () => {
    const { manager, fake, layout } = makeManager();
    const { session, worker } = await manager.spawnWorker("proj", { issueNumber: 4 });

    expect(session.tmuxSession).toBe("agentskiss-proj-worker-1");
    expect(session.role).toBe("worker");
    expect(session.workerId).toBe(worker.id);
    expect(worker.sessionId).toBe(session.id);
    expect(worker.issueNumber).toBe(4);
    expect(worker.prNumber).toBeNull();
    expect(worker.status).toBe("running");

    const pane = fake.sessions.get("agentskiss-proj-worker-1");
    expect(pane?.cwd).toBe(layout.cloneDir("proj"));
    expect(pane?.command).toEqual(["pi"]);
  });

  it("honors cwd and command overrides and picks the next free name", async () => {
    const { manager, fake } = makeManager();
    const worktree = path.join(stateDir, "wt");
    const first = await manager.spawnWorker("proj", {
      issueNumber: 1,
      cwd: worktree,
      command: ["bash", "-c", "sleep 300"],
    });
    const second = await manager.spawnWorker("proj", { issueNumber: 2 });

    expect(first.session.tmuxSession).toBe("agentskiss-proj-worker-1");
    expect(second.session.tmuxSession).toBe("agentskiss-proj-worker-2");
    expect(fake.sessions.get("agentskiss-proj-worker-1")?.cwd).toBe(worktree);
  });

  it("resumes numbering after reload without name collisions", async () => {
    const { manager, layout } = makeManager();
    await manager.spawnWorker("proj", { issueNumber: 1 });
    await manager.spawnWorker("proj", { issueNumber: 2 });

    // In-process reload: a fresh registry + manager over the same state dir.
    const registry2 = new SessionRegistry(layout.sessionsFilePath());
    const manager2 = new SessionManager({
      tmux: new Tmux({
        runner: (() => {
          const fake = new FakeTmuxRunner();
          // Simulate the live tmux server still knowing session 1.
          fake.sessions.set("agentskiss-proj-worker-1", {
            command: ["pi"],
            cwd: undefined,
            paneLines: [],
            cols: 80,
            rows: 24,
          });
          return fake.asRunner();
        })(),
      }),
      registry: registry2,
      layout,
    });
    const next = await manager2.spawnWorker("proj", { issueNumber: 3 });
    // Registry reload knows about workers 1 and 2; live tmux still has 1 → next free is 3.
    expect(next.session.tmuxSession).toBe("agentskiss-proj-worker-3");
  });

  it("captures panes and resizes via session ids", async () => {
    const { manager, fake } = makeManager();
    const { session } = await manager.spawnWorker("proj", { issueNumber: 4 });
    fake.sessions.set(session.tmuxSession, {
      command: ["pi"],
      cwd: undefined,
      paneLines: ["line1", "line2"],
      cols: 80,
      rows: 24,
    });

    expect(await manager.capturePane(session.id)).toBe("line1\nline2");
    await manager.resize(session.id, 120, 40);
    expect(fake.sessions.get(session.tmuxSession)?.cols).toBe(120);
  });

  it("kills sessions and marks attached workers stopped", async () => {
    const { manager, fake } = makeManager();
    const { session, worker } = await manager.spawnWorker("proj", { issueNumber: 4 });

    const removed = await manager.killSession(session.id);
    expect(removed?.id).toBe(session.id);
    expect(fake.sessions.has(session.tmuxSession)).toBe(false);
    expect(manager.getWorker(worker.id)?.status).toBe("stopped");
    expect(manager.listSessions("proj")).toEqual([]);

    expect(await manager.killSession("sess-missing")).toBeNull();
  });

  it("killSession leaves archived workers archived (issue #64)", async () => {
    const { manager, fake } = makeManager();
    const { session, worker } = await manager.spawnWorker("proj", { issueNumber: 4 });
    await manager.archiveWorker(worker.id);

    // Re-kill via tmux re-attach simulating an external cleanup path.
    fake.sessions.set(session.tmuxSession, fakePaneState(["pi"], undefined));
    await manager.killSession(session.id);
    expect(manager.getWorker(worker.id)?.status).toBe("archived");
  });

  it("marks workers failed and cleans up when tmux launch fails", async () => {
    makeManager();
    const broken = new SessionManager({
      tmux: new Tmux({
        runner: (args) => {
          const cmd = args[0] === "-L" ? args[2] : args[0];
          if (cmd === "new-session") {
            return Promise.reject(
              new TmuxError("tmux new-session failed: no space left on device", {
                args,
                exitCode: 1,
                stderr: "no space left on device",
              }),
            );
          }
          const fake = new FakeTmuxRunner();
          return fake.run(args);
        },
      }),
      registry: new SessionRegistry(path.join(stateDir, "sessions.json")),
      layout: new ProjectLayout(stateDir),
    });

    await expect(broken.spawnWorker("proj", { issueNumber: 4 })).rejects.toThrow();
    const [worker] = broken.listWorkers({ projectId: "proj" });
    expect(worker?.status).toBe("failed");
    expect(worker?.statusMessage).toContain("no space left");
    expect(broken.listSessions("proj")).toEqual([]);
  });

  it("exposes shared-contract-shaped queries", async () => {
    const { manager } = makeManager();
    await manager.ensureOrchestrator("proj");
    const { worker } = await manager.spawnWorker("proj", { issueNumber: 4 });
    manager.setWorkerPr(worker.id, 42);

    expect(manager.listSessions("proj")).toHaveLength(2);
    expect(manager.listWorkers({ projectId: "proj", status: "running" })).toHaveLength(1);
    expect(manager.getWorker(worker.id)?.prNumber).toBe(42);
    manager.updateWorkerStatus(worker.id, "awaiting_ci", "waiting on CI");
    expect(manager.getWorker(worker.id)?.status).toBe("awaiting_ci");
  });
});
