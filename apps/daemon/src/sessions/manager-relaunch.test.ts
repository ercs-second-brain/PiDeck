/**
 * Tests for `SessionManager.relaunchSession` (issue #117): the recovery
 * path for a pane the user exited or that otherwise died — kill any
 * lingering tmux session of the name (idempotent weird-state cleanup),
 * then re-run the session's launch path while preserving the registry
 * record (identity/history). Archived sessions are rejected.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectLayout } from "./layout.js";
import { SessionManager } from "./manager.js";
import { DEFAULT_WORKER_COMMAND, resurrectionCommand } from "./manager.js";
import { SessionRegistry } from "./registry.js";
import { FakeTmuxRunner } from "./testing/fake-tmux.js";
import { FakeGitRunner } from "./testing/fake-git.js";
import { Tmux } from "./tmux.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "pideck-relaunch-"));
});

function makeManager(): {
  manager: SessionManager;
  fake: FakeTmuxRunner;
  layout: ProjectLayout;
} {
  const fake = new FakeTmuxRunner();
  const tmux = new Tmux({ runner: (args) => fake.run(args) });
  const layout = new ProjectLayout(stateDir);
  const registry = new SessionRegistry(layout.sessionsFilePath());
  return { manager: new SessionManager({ tmux, registry, layout, git: new FakeGitRunner().asRunner() }), fake, layout };
}

const fakePaneState = (command: string[], cwd: string | undefined) => ({
  command,
  cwd,
  paneLines: [] as string[],
  cols: 80,
  rows: 24,
});

describe("SessionManager.relaunchSession (issue #117)", () => {
  it("relaunches a dead worker pane from its recorded cwd/command, keeping identity", async () => {
    const { manager, fake } = makeManager();
    const worktree = path.join(stateDir, "worktrees", "issue-117");
    const spawned = await manager.spawnWorker("proj", {
      issueNumber: 117,
      cwd: worktree,
      command: ["bash", "-c", "sleep 300"],
    });
    await manager.updateWorkerStatus(spawned.worker.id, "stopped", "pane died");

    const relaunched = await manager.relaunchSession(spawned.session.id);

    // Identity preserved: same registry record, only the pane is new.
    expect(relaunched.id).toBe(spawned.session.id);
    expect(relaunched.tmuxSession).toBe(spawned.session.tmuxSession);
    const pane = fake.sessions.get(spawned.session.tmuxSession);
    expect(pane?.cwd).toBe(worktree);
    expect(pane?.command).toEqual(resurrectionCommand(["bash", "-c", "sleep 300"]));

    // A stopped worker goes back to running (pane is alive again).
    expect(manager.getWorker(spawned.worker.id)?.status).toBe("running");
    expect(manager.getWorker(spawned.worker.id)?.statusMessage).toContain("relaunched");
  });

  it("kills a lingering tmux session of the same name first (idempotent weird-state cleanup)", async () => {
    const { manager, fake } = makeManager();
    const { session } = await manager.spawnWorker("proj", { issueNumber: 3 });
    // Stale pane in a weird state (e.g. user's shell after Ctrl+C + exit).
    fake.sessions.set(session.tmuxSession, fakePaneState(["sh"], undefined));

    const relaunched = await manager.relaunchSession(session.id);

    expect(relaunched.id).toBe(session.id);
    const pane = fake.sessions.get(session.tmuxSession);
    expect(pane?.command).toEqual(resurrectionCommand(DEFAULT_WORKER_COMMAND));
    const kills = fake.invocations.filter((inv) => inv.args[0] === "kill-session");
    expect(kills).toHaveLength(1);
  });

  it("relaunches an orchestrator with a plain shell in its project dir", async () => {
    const { manager, fake, layout } = makeManager();
    const orchestrator = await manager.ensureOrchestrator("proj");
    fake.sessions.delete(orchestrator.tmuxSession); // user exited pi

    const relaunched = await manager.relaunchSession(orchestrator.id);

    expect(relaunched.id).toBe(orchestrator.id);
    const pane = fake.sessions.get(orchestrator.tmuxSession);
    expect(pane?.cwd).toBe(layout.projectDir("proj"));
    expect(pane?.command).toEqual([]); // tmux default shell, like ensureOrchestrator
  });

  it("leaves terminal worker statuses alone when relaunching their pane", async () => {
    const { manager } = makeManager();
    const spawned = await manager.spawnWorker("proj", { issueNumber: 4 });
    await manager.updateWorkerStatus(spawned.worker.id, "done", "PR merged");

    await manager.relaunchSession(spawned.session.id);

    expect(manager.getWorker(spawned.worker.id)?.status).toBe("done");
  });

  it("rejects archived worker sessions", async () => {
    const { manager } = makeManager();
    const spawned = await manager.spawnWorker("proj", { issueNumber: 5 });
    await manager.archiveWorker(spawned.worker.id);

    await expect(manager.relaunchSession(spawned.session.id)).rejects.toThrow(/archived/);
  });

  it("throws for unknown sessions", async () => {
    const { manager } = makeManager();
    await expect(manager.relaunchSession("sess-ghost")).rejects.toThrow("unknown session");
  });
});

describe("extended-keys on daemon-created sessions (issue #222)", () => {
  it("sets extended-keys on at every session-creation path", async () => {
    // pi warns (and modified Enter may not work) when the session-scoped
    // extended-keys option is off — tmux's server-wide default. Every path
    // that creates a daemon session must enable it.
    const { manager, fake } = makeManager();
    const worktree = path.join(stateDir, "worktrees", "issue-222");
    const spawned = await manager.spawnWorker("proj", {
      issueNumber: 222,
      cwd: worktree,
      command: ["bash", "-c", "sleep 300"],
    });
    const orch = await manager.ensureOrchestrator("proj");

    expect(fake.sessions.get(spawned.session.tmuxSession)?.extendedKeys).toBe("on");
    expect(fake.sessions.get(orch.tmuxSession)?.extendedKeys).toBe("on");

    // Relaunch (#117) and reconcile-resurrect (#27) re-run the same path.
    fake.sessions.delete(spawned.session.tmuxSession);
    await manager.relaunchSession(spawned.session.id);
    expect(fake.sessions.get(spawned.session.tmuxSession)?.extendedKeys).toBe("on");

    fake.sessions.delete(orch.tmuxSession);
    await manager.reconcile();
    expect(fake.sessions.get(orch.tmuxSession)?.extendedKeys).toBe("on");
  });
});
