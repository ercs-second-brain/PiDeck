import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectLayout } from "./layout.js";
import { SessionManager } from "./manager.js";
import {
  RESURRECT_WORKER_COMMAND,
  deserializeCommand,
  parseTmuxSessionName,
  resurrectionCommand,
  sanitizeTmuxSegment,
  serializeCommand,
} from "./manager.js";
import { SessionRegistry } from "./registry.js";
import { FakeTmuxRunner } from "./testing/fake-tmux.js";
import { FakeGitRunner } from "./testing/fake-git.js";
import { Tmux, TmuxError } from "./tmux.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "pideck-manager-"));
});

function makeManager(): {
  manager: SessionManager;
  fake: FakeTmuxRunner;
  git: FakeGitRunner;
  registry: SessionRegistry;
  layout: ProjectLayout;
} {
  const fake = new FakeTmuxRunner();
  const git = new FakeGitRunner();
  const tmux = new Tmux({ runner: (args) => fake.run(args) });
  const layout = new ProjectLayout(stateDir);
  const registry = new SessionRegistry(layout.sessionsFilePath());
  return { manager: new SessionManager({ tmux, registry, layout, git: git.asRunner() }), fake, git, registry, layout };
}

describe("sanitizeTmuxSegment", () => {
  it("strips characters tmux forbids in session names", () => {
    expect(sanitizeTmuxSegment("my.project:2")).toBe("my-project-2");
    expect(sanitizeTmuxSegment("../etc")).toBe("etc");
  });
});

describe("parseTmuxSessionName", () => {
  it("parses daemon-managed names and rejects foreign ones", () => {
    expect(parseTmuxSessionName("pideck-my-proj-worker-12")).toEqual({
      projectId: "my-proj",
      role: "worker",
      n: 12,
    });
    expect(parseTmuxSessionName("pideck-proj-orchestrator-1")).toEqual({
      projectId: "proj",
      role: "orchestrator",
      n: 1,
    });
    expect(parseTmuxSessionName("pideck-proj-worker-x")).toBeNull();
    expect(parseTmuxSessionName("my-personal-session")).toBeNull();
    expect(parseTmuxSessionName("pideck-proj-chat-1")).toBeNull();
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

describe("SessionManager with a fake tmux server", () => {
  it("creates a named orchestrator session per project, once", async () => {
    const { manager, fake } = makeManager();
    const session = await manager.ensureOrchestrator("proj");

    expect(session.role).toBe("orchestrator");
    expect(session.tmuxSession).toBe("pideck-proj-orchestrator-1");
    expect(session.workerId).toBeNull();
    expect(fake.sessions.has("pideck-proj-orchestrator-1")).toBe(true);

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
    expect(second.tmuxSession).toBe("pideck-proj-orchestrator-2");
    expect(registry.getSession(first.id)).toBeDefined(); // stale record kept for audit
  });

  it("spawns a worker running pi in a fresh per-worker worktree and registers it", async () => {
    const { manager, fake } = makeManager();
    const { session, worker } = await manager.spawnWorker("proj", { issueNumber: 4 });

    expect(session.tmuxSession).toBe("pideck-proj-worker-1");
    expect(session.role).toBe("worker");
    expect(session.workerId).toBe(worker.id);
    expect(worker.sessionId).toBe(session.id);
    expect(worker.issueNumber).toBe(4);
    expect(worker.prNumber).toBeNull();
    expect(worker.status).toBe("running");

    const pane = fake.sessions.get("pideck-proj-worker-1");
    expect(pane?.cwd).toBe(session.cwd);
    // Issue #287: the default workspace is a per-worker worktree, not the clone.
    expect(session.cwd).toContain(path.join("worktrees", "worker-"));
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

    expect(first.session.tmuxSession).toBe("pideck-proj-worker-1");
    expect(second.session.tmuxSession).toBe("pideck-proj-worker-2");
    expect(fake.sessions.get("pideck-proj-worker-1")?.cwd).toBe(worktree);
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
          fake.sessions.set("pideck-proj-worker-1", {
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
      git: new FakeGitRunner().asRunner(),
    });
    const next = await manager2.spawnWorker("proj", { issueNumber: 3 });
    // Registry reload knows about workers 1 and 2; live tmux still has 1 → next free is 3.
    expect(next.session.tmuxSession).toBe("pideck-proj-worker-3");
  });
});

describe("SessionManager lifecycle passthroughs (kill/capture/resize/failed launch)", () => {
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
      git: new FakeGitRunner().asRunner(),
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
