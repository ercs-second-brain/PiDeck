/**
 * Integration tests against a real tmux server.
 *
 * Skipped gracefully when tmux is unavailable (e.g. CI runners without
 * tmux); the offline behavior is covered by the fake-based unit tests.
 * Runs on a private tmux socket (`-L agentskiss-test-<pid>`) so it never
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

const SOCKET = `agentskiss-test-${process.pid}`;
const tmuxAvailable = await Tmux.isAvailable();

const execFileP = promisify(execFile);

let stateDir = "";
let tmux: Tmux;
let layout: ProjectLayout;
let manager: SessionManager;

beforeAll(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "agentskiss-integration-"));
  tmux = new Tmux({ socketName: SOCKET });
  layout = new ProjectLayout(stateDir);
  manager = new SessionManager({
    tmux,
    registry: new SessionRegistry(layout.sessionsFilePath()),
    layout,
  });
});

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
    await tmux.newSession("agentskiss-it-orchestrator-1");
    await tmux.newSession("agentskiss-it-worker-1", {
      cwd: stateDir,
      command: ["bash", "-c", "sleep 300"],
    });

    const names = await tmux.listSessions();
    expect(names).toContain("agentskiss-it-orchestrator-1");
    expect(names).toContain("agentskiss-it-worker-1");
    expect(await tmux.hasSession("agentskiss-it-worker-1")).toBe(true);

    await tmux.killSession("agentskiss-it-orchestrator-1");
    expect(await tmux.hasSession("agentskiss-it-orchestrator-1")).toBe(false);
  }, 15_000);

  it("ensures one orchestrator session per project", async () => {
    const first = await manager.ensureOrchestrator("itproj");
    expect(first.tmuxSession).toBe("agentskiss-itproj-orchestrator-1");
    expect(await tmux.hasSession(first.tmuxSession)).toBe(true);

    const again = await manager.ensureOrchestrator("itproj");
    expect(again.id).toBe(first.id);
  }, 15_000);

  it("spawns a worker in the project clone dir and registers it", async () => {
    const { session, worker } = await manager.spawnWorker("itproj", {
      issueNumber: 4,
      command: ["bash", "-c", "echo WORKER_READY; exec sleep 300"],
    });

    expect(session.tmuxSession).toBe("agentskiss-itproj-worker-1");
    expect(worker.status).toBe("running");
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
