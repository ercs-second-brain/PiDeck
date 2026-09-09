/**
 * Unit tests for the worker workspace preparation path (issue #287):
 * default-path spawns fetch the project's clone and start the worker in a
 * per-worker worktree branched off origin's current default branch; a
 * fetch failure aborts the spawn loudly instead of starting on a stale
 * base (finding B26).
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectLayout } from "./layout.js";
import { RESURRECT_WORKER_COMMAND, SessionManager, resurrectionCommand } from "./manager.js";
import { SessionRegistry } from "./registry.js";
import { FakeGitRunner } from "./testing/fake-git.js";
import { FakeTmuxRunner } from "./testing/fake-tmux.js";
import { Tmux } from "./tmux.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "pideck-workspace-"));
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

describe("worker workspace preparation (issue #287)", () => {
  it("bases the default workspace on a fetched origin: fetch, then a per-worker worktree off origin/HEAD", async () => {
    const { manager, git, layout } = makeManager();
    const spawned = await manager.spawnWorker("proj", { issueNumber: 1 });

    expect(git.invocations.map((inv) => inv.args[0])).toEqual(["fetch", "symbolic-ref", "worktree", "worktree"]);
    expect(git.invocations[0]?.args).toEqual(["fetch", "origin", "--prune"]);
    expect(git.invocations[0]?.cwd).toBe(layout.cloneDir("proj")); // runs in the clone
    expect(git.invocations[1]?.args).toContain("refs/remotes/origin/HEAD");
    const worktree = git.invocations[3]?.args ?? [];
    expect(worktree.slice(0, 3)).toEqual(["worktree", "add", "-b"]);
    expect(worktree[3]).toMatch(/^pideck\/worker-/); // fresh per-worker branch
    expect(worktree[worktree.length - 1]).toBe("origin/main"); // base = origin/HEAD's target
    expect(worktree).toContain(layout.worktreeDir("proj", path.basename(spawned.session.cwd!)));
    // The pane runs in the fresh worktree, and the recorded cwd matches it.
    expect(spawned.session.cwd).toBe(layout.worktreeDir("proj", path.basename(spawned.session.cwd!)));
  });

  it("aborts the spawn loudly when the fetch fails: worker failed, no session, no tmux pane", async () => {
    const { manager, git, fake, registry } = makeManager();
    git.failOn("fetch", new Error("network unreachable"));

    await expect(manager.spawnWorker("proj", { issueNumber: 2 })).rejects.toThrow(/refusing to start on a stale base/);
    // Nothing half-registered: the failed worker is recorded, its session is gone.
    const workers = registry.listWorkers({ projectId: "proj" });
    expect(workers).toHaveLength(1);
    expect(workers[0]?.status).toBe("failed");
    expect(workers[0]?.statusMessage).toContain("refusing to start on a stale base");
    expect(registry.listSessions({ projectId: "proj" })).toEqual([]);
    expect(fake.sessions.size).toBe(0);
  });

  it("aborts the spawn when origin's default branch cannot be resolved", async () => {
    const { manager, git } = makeManager();
    git.failOn("symbolic-ref", new Error("origin/HEAD is unset"));

    await expect(manager.spawnWorker("proj", { issueNumber: 3 })).rejects.toThrow(/cannot resolve origin's default branch/);
  });

  it("honors an explicit cwd without touching git", async () => {
    const { manager, git, fake } = makeManager();
    const custom = path.join(stateDir, "custom", "workspace");

    const spawned = await manager.spawnWorker("proj", { issueNumber: 4, cwd: custom });

    expect(git.invocations).toEqual([]); // caller-owned workspace: no fetch, no worktree
    expect(spawned.session.cwd).toBe(custom);
    expect(fake.sessions.get(spawned.session.tmuxSession)?.cwd).toBe(custom);
  });

  it("discards the prepared worktree when the tmux launch subsequently fails", async () => {
    const git = new FakeGitRunner();
    const fake = new FakeTmuxRunner();
    const layout = new ProjectLayout(stateDir);
    const registry = new SessionRegistry(layout.sessionsFilePath());
    const tmux = new Tmux({
      runner: async (args) => {
        if (args.includes("new-session")) throw new Error("tmux exploded");
        return fake.run(args);
      },
    });
    const manager = new SessionManager({ tmux, registry, layout, git: git.asRunner() });

    await expect(manager.spawnWorker("proj", { issueNumber: 5 })).rejects.toThrow();
    const removes = git.invocations.filter((inv) => inv.args[0] === "worktree" && inv.args[1] === "remove");
    expect(removes).toHaveLength(1);
    expect(removes[0]?.args).toContain("--force");
    expect(registry.listSessions({ projectId: "proj" })).toEqual([]);
    expect(registry.listWorkers({ projectId: "proj" })[0]?.status).toBe("failed");
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
      git: new FakeGitRunner().asRunner(),
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
      git: new FakeGitRunner().asRunner(),
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
