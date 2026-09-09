/**
 * Reconcile + archive tests for {@link SessionManager} (issues #15/#27/#64):
 * startup re-discovery, resurrection of sessions lost to daemon restarts or
 * reboots, adoption of orphaned tmux sessions, and worker archiving with
 * scrollback capture. Split from manager.test.ts to respect the max-lines
 * budget (kiss ratchet).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionManagerSpawner } from "../pipeline/issues/ports.js";
import { ProjectLayout } from "./layout.js";
import { RESURRECT_WORKER_COMMAND, SessionManager } from "./manager.js";
import { SessionRegistry } from "./registry.js";
import { FakeGitRunner } from "./testing/fake-git.js";
import { FakeTmuxRunner } from "./testing/fake-tmux.js";
import { Tmux, TmuxError } from "./tmux.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "pideck-reconcile-"));
});

const fakePaneState = (command: string[], cwd: string | undefined) => ({
  command,
  cwd,
  paneLines: [] as string[],
  cols: 80,
  rows: 24,
});

function makeManager(): { manager: SessionManager; fake: FakeTmuxRunner; layout: ProjectLayout } {
  const fake = new FakeTmuxRunner();
  const layout = new ProjectLayout(stateDir);
  const manager = new SessionManager({
    tmux: new Tmux({ runner: (args) => fake.run(args) }),
    registry: new SessionRegistry(layout.sessionsFilePath()),
    layout,
    git: new FakeGitRunner().asRunner(),
  });
  return { manager, fake, layout };
}

describe("SessionManager.reconcile (issue #15)", () => {
  it("re-attaches prior sessions after a daemon restart (tmux still alive)", async () => {
    const fake = new FakeTmuxRunner();
    const tmux = new Tmux({ runner: (args) => fake.run(args) });
    const layout = new ProjectLayout(stateDir);
    const registry = new SessionRegistry(layout.sessionsFilePath());
    const manager = new SessionManager({ tmux, registry, layout, git: new FakeGitRunner().asRunner() });
    const spawned = await manager.spawnWorker("proj", { issueNumber: 1 });
    await manager.ensureOrchestrator("proj");
    fake.sessions.set(spawned.session.tmuxSession, {
      ...fakePaneState(["pi"], layout.cloneDir("proj")),
      paneLines: ["hello from the old pane"],
    });

    // Daemon restart: fresh registry + manager over the same state dir and
    // the same, still-running tmux server.
    const registry2 = new SessionRegistry(layout.sessionsFilePath());
    const manager2 = new SessionManager({ tmux, registry: registry2, layout, git: new FakeGitRunner().asRunner() });
    const result = await manager2.reconcile();

    expect(result.alive.map((s) => s.tmuxSession)).toEqual(
      expect.arrayContaining([spawned.session.tmuxSession, "pideck-proj-orchestrator-1"]),
    );
    expect(result.resurrected).toEqual([]);
    expect(result.lost).toEqual([]);
    expect(result.adopted).toEqual([]);
    // Re-attachable: pane capture + sendKeys work through the new manager.
    expect(await manager2.capturePane(spawned.session.id)).toContain("hello from the old pane");
    await manager2.sendKeys(spawned.session.id, "hi", { enter: true });
    expect(fake.sessions.get(spawned.session.tmuxSession)?.paneLines).toContain("hi");
  });
});

describe("SessionManager.reconcile: reboot resurrection + lost sessions (issue #15/#27)", () => {
  it("resurrects sessions after a reboot (tmux server gone)", async () => {
    const fake = new FakeTmuxRunner();
    const tmux = new Tmux({ runner: (args) => fake.run(args) });
    const layout = new ProjectLayout(stateDir);
    layout.ensureProject("proj");
    const registry = new SessionRegistry(layout.sessionsFilePath());
    const manager = new SessionManager({ tmux, registry, layout, git: new FakeGitRunner().asRunner() });
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
      git: new FakeGitRunner().asRunner(),
    });
    const result = await manager2.reconcile();

    expect(result.resurrected.map((s) => s.tmuxSession)).toEqual(
      expect.arrayContaining([worker.session.tmuxSession, orchestrator.tmuxSession]),
    );
    expect(result.lost).toEqual([]);
    // Worker pane is resurrected via the shell-fallback command (runs the
    // agent when it is on PATH, else an interactive shell) in the worker's
    // recorded workspace (its fresh worktree, issue #287); orchestrator gets
    // a plain shell in the project dir.
    const workerPane = rebooted.sessions.get(worker.session.tmuxSession);
    expect(workerPane?.command).toEqual(RESURRECT_WORKER_COMMAND);
    expect(workerPane?.cwd).toBe(worker.session.cwd);
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
    const manager = new SessionManager({ tmux, registry, layout, git: new FakeGitRunner().asRunner() });
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
      git: new FakeGitRunner().asRunner(),
    });
    const result = await manager2.reconcile();

    expect(result.lost.map((s) => s.id)).toContain(spawned.session.id);
    expect(result.resurrected).toEqual([]);
    const worker = manager2.getWorker(spawned.worker.id);
    expect(worker?.status).toBe("stopped");
    expect(worker?.statusMessage).toContain("tmux pane died");
  });
});

describe("SessionManager.reconcile: adoption + lost sessions (issue #15/#64)", () => {
  it("marks workers stopped without resurrecting when asked (resurrect: false)", async () => {
    const fake = new FakeTmuxRunner();
    const layout = new ProjectLayout(stateDir);
    const registry = new SessionRegistry(layout.sessionsFilePath());
    const manager = new SessionManager({
      tmux: new Tmux({ runner: (args) => fake.run(args) }),
      registry,
      layout,
      git: new FakeGitRunner().asRunner(),
    });
    const spawned = await manager.spawnWorker("proj", { issueNumber: 1 });
    fake.sessions.clear(); // pane died

    const registry2 = new SessionRegistry(layout.sessionsFilePath());
    const manager2 = new SessionManager({
      tmux: new Tmux({ runner: new FakeTmuxRunner().asRunner() }),
      registry: registry2,
      layout,
      git: new FakeGitRunner().asRunner(),
    });
    const result = await manager2.reconcile({ resurrect: false });

    expect(result.lost.map((s) => s.id)).toContain(spawned.session.id);
    expect(manager2.getWorker(spawned.worker.id)?.status).toBe("stopped");
  });

  it("adopts live daemon-named tmux sessions missing from the registry", async () => {
    const fake = new FakeTmuxRunner();
    fake.sessions.set("pideck-lostproj-worker-1", fakePaneState(["pi"], undefined));
    fake.sessions.set("someone-elses-session", fakePaneState(["bash"], undefined));
    const layout = new ProjectLayout(stateDir);
    const manager = new SessionManager({
      tmux: new Tmux({ runner: (args) => fake.run(args) }),
      registry: new SessionRegistry(layout.sessionsFilePath()),
      layout,
      git: new FakeGitRunner().asRunner(),
    });

    const result = await manager.reconcile({ resurrect: false });

    expect(result.adopted.map((s) => s.tmuxSession)).toEqual(["pideck-lostproj-worker-1"]);
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
      git: new FakeGitRunner().asRunner(),
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
      git: new FakeGitRunner().asRunner(),
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
      git: new FakeGitRunner().asRunner(),
    });
    const result = await manager2.reconcile();

    // Only archived workers are skipped: a stopped worker still resurrects.
    expect(result.resurrected.map((s) => s.tmuxSession)).toEqual([stopped.session.tmuxSession]);
    expect(rebooted.sessions.has(stopped.session.tmuxSession)).toBe(true);
  });
});
