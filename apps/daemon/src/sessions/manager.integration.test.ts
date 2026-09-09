/**
 * Integration tests against a real tmux server.
 *
 * Skipped gracefully when tmux is unavailable (e.g. CI runners without
 * tmux); the offline behavior is covered by the fake-based unit tests.
 * Runs on a private tmux socket (`-L pideck-test-<pid>`) so it never
 * touches the developer's own tmux server.
 */

import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectLayout } from "./layout.js";
import { SessionManager } from "./manager.js";
import { SessionRegistry } from "./registry.js";
import { Tmux } from "./tmux.js";

const SOCKET = `pideck-test-${process.pid}`;
const tmuxAvailable = await Tmux.isAvailable();

const execFileP = promisify(execFile);

let stateDir = "";
let tmux: Tmux;
let layout: ProjectLayout;
let manager: SessionManager;

/**
 * Real git fixture for the workspace-preparation path (issue #287): a bare
 * "origin" repo plus the daemon-layout clone of it, with one commit on
 * `main` and origin/HEAD set — mirroring what `cloneRepo` produces for a
 * GitHub-hosted project.
 */
async function seedProjectRepo(projectId: string): Promise<void> {
  const originDir = path.join(stateDir, `fixtures/${projectId}-origin.git`);
  const cloneDir = layout.cloneDir(projectId);
  const g = (args: string[], cwd?: string) => execFileP("git", args, cwd === undefined ? {} : { cwd });
  await g(["init", "--bare", "-b", "main", originDir]);
  await g(["clone", originDir, cloneDir]);
  await g(["-c", "user.email=t@pideck.test", "-c", "user.name=pideck-test", "commit", "--allow-empty", "-m", "seed"], cloneDir);
  await g(["push", "origin", "HEAD"], cloneDir);

  await g(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], cloneDir);
}

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), "pideck-integration-"));
  tmux = new Tmux({ socketName: SOCKET });
  layout = new ProjectLayout(stateDir);
  manager = new SessionManager({
    tmux,
    registry: new SessionRegistry(layout.sessionsFilePath()),
    layout,
  });
  await seedProjectRepo("itproj");
}, 30_000);

afterAll(async () => {
  if (!tmuxAvailable) return;
  try {
    await tmux.run(["kill-server"]);
  } catch {
    // server may already be gone
  }
});

describe.skipIf(!tmuxAvailable)("SessionManager against a real tmux server", () => {
  it("creates, lists, and kills tmux sessions", async () => {
    await tmux.newSession("pideck-it-orchestrator-1");
    await tmux.newSession("pideck-it-worker-1", {
      cwd: stateDir,
      command: ["bash", "-c", "sleep 300"],
    });

    const names = await tmux.listSessions();
    expect(names).toContain("pideck-it-orchestrator-1");
    expect(names).toContain("pideck-it-worker-1");
    expect(await tmux.hasSession("pideck-it-worker-1")).toBe(true);

    await tmux.killSession("pideck-it-orchestrator-1");
    expect(await tmux.hasSession("pideck-it-orchestrator-1")).toBe(false);
  }, 15_000);

  it("ensures one orchestrator session per project", async () => {
    const first = await manager.ensureOrchestrator("itproj");
    expect(first.tmuxSession).toBe("pideck-itproj-orchestrator-1");
    expect(await tmux.hasSession(first.tmuxSession)).toBe(true);

    const again = await manager.ensureOrchestrator("itproj");
    expect(again.id).toBe(first.id);
  }, 15_000);

  it("spawns a worker in a fresh per-worker worktree and registers it (issue #287)", async () => {
    const { session, worker } = await manager.spawnWorker("itproj", {
      issueNumber: 4,
      command: ["bash", "-c", "echo WORKER_READY; exec sleep 300"],
    });

    expect(session.tmuxSession).toBe("pideck-itproj-worker-1");
    expect(worker.status).toBe("running");
    // The pane runs in the fresh per-worker worktree branched off origin's HEAD.
    expect(session.cwd).toContain(path.join("worktrees", "worker-"));
    const cwd0 = session.cwd as string;
    const gitAt = (args: string[], cwd: string) => execFileP("git", args, { cwd }).then((r) => r.stdout.trim());
    expect(await gitAt(["rev-parse", "--abbrev-ref", "HEAD"], cwd0)).toBe(`pideck/${path.basename(cwd0)}`);
    // The worktree starts exactly at origin/main's current HEAD (issue #287).
    expect(await gitAt(["rev-parse", "HEAD"], cwd0))
      .toBe(await gitAt(["rev-parse", "origin/main"], layout.cloneDir("itproj")));
    expect(await tmux.hasSession(session.tmuxSession)).toBe(true);
    expect(manager.listSessions("itproj").map((s) => s.tmuxSession)).toContain(
      session.tmuxSession,
    );

    // The worker's command runs in the pane; wait for its output.
    let pane = "";
    for (let i = 0; i < 50; i++) {
      pane = await tmux.capturePane(session.tmuxSession, { lines: 50 });
      if (pane.includes("WORKER_READY")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(pane).toContain("WORKER_READY");

    await manager.resize(session.id, 120, 40);
    const size = await tmux.run(["display-message", "-p", "-t", `${session.tmuxSession}:`, "#{window_width}x#{window_height}"]);
    expect(size.stdout.trim()).toBe("120x40");

    await manager.killSession(session.id);
    expect(await tmux.hasSession(session.tmuxSession)).toBe(false);
    expect(manager.getWorker(worker.id)?.status).toBe("stopped");
  }, 30_000);

  it("resurrects sessions after the tmux server dies (reboot path)", async () => {
    const { session } = await manager.spawnWorker("itproj", {
      issueNumber: 15,
      command: ["bash", "-c", "sleep 300"],
    });
    expect(await tmux.hasSession(session.tmuxSession)).toBe(true);

    // Simulate a reboot: kill the whole server, wait for it to be fully
    // gone (shutdown is asynchronous — racing it yields "server exited
    // unexpectedly"), then reconcile from the persisted registry.
    await tmux.run(["kill-server"]);
    for (let i = 0; i < 50; i++) {
      try {
        if ((await tmux.listSessions()).length === 0) break;
      } catch {
        // transient errors while the server shuts down; retry
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const manager2 = new SessionManager({
      tmux,
      registry: new SessionRegistry(layout.sessionsFilePath()),
      layout,
    });
    const result = await manager2.reconcile();
    expect(result.resurrected.map((s) => s.tmuxSession)).toContain(session.tmuxSession);
    expect(await tmux.hasSession(session.tmuxSession)).toBe(true);
    expect(await manager2.capturePane(session.id)).toBeDefined();
  }, 15_000);
});

describe.skipIf(!tmuxAvailable)("SessionManager launches pi when installed", () => {
  it("launches the pi coding agent in a worker pane (when pi is installed)", async () => {
    const piOnPath = await execFileP("which", ["pi"])
      .then(() => true)
      .catch(() => false);
    if (!piOnPath) return; // environment without the pi CLI

    const { session, worker } = await manager.spawnWorker("itproj", { issueNumber: 4 });

    expect(await tmux.hasSession(session.tmuxSession)).toBe(true);
    expect(worker.status).toBe("running");

    // pi should paint its interactive UI into the pane shortly after launch.
    let pane = "";
    for (let i = 0; i < 100; i++) {
      pane = await tmux.capturePane(session.tmuxSession, { lines: 100 });
      if (pane.trim().length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(pane.trim().length).toBeGreaterThan(0);

    await manager.killSession(session.id);
  }, 30_000);
});
