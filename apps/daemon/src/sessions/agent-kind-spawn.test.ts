/**
 * Agent-kind spawn mechanics (docs/agent-kinds.md, issues #297/#300/#302):
 * sessions — never worker records — with the per-kind workspace rules
 * (fresh-origin worktree for worker-like audits, project clone for cheap
 * researchers) and a **bare shell** pane: putting pi in with the persona
 * is the bootstrap's job (#290 pattern, issue #310), shared by spawn,
 * relaunch, and the startup sweep.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectLayout } from "./layout.js";
import { SessionManager } from "./manager.js";
import { SessionRegistry } from "./registry.js";
import { FakeGitRunner } from "./testing/fake-git.js";
import { FakeTmuxRunner } from "./testing/fake-tmux.js";
import { Tmux } from "./tmux.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "pideck-agent-kind-"));
});

function makeManager() {
  const fake = new FakeTmuxRunner();
  const git = new FakeGitRunner();
  const tmux = new Tmux({ runner: (args) => fake.run(args) });
  const layout = new ProjectLayout(stateDir);
  const registry = new SessionRegistry(layout.sessionsFilePath());
  const manager = new SessionManager({ tmux, registry, layout, git: git.asRunner() });
  return { manager, fake, git, registry, layout };
}

describe("agent-kind spawn (docs/agent-kinds.md, issue #365 workspace inheritance)", () => {
  it("spawns a cheap kind in its own worktree off fresh main when the parent has no git state (fallback path)", async () => {
    const { manager, git, registry, fake, layout } = makeManager();

    const session = await manager.spawnAgentKind("proj", {
      kind: "researcher",
      parentSessionId: "sess-caller-1", // unknown parent — no state to inherit
      name: "inv",
    });

    // A session, not a worker: no workerId, kind + parent lineage recorded.
    expect(session.role).toBe("worker");
    expect(session.workerId).toBeNull();
    expect(session.agentKind).toBe("researcher");
    expect(session.parentSessionId).toBe("sess-caller-1");
    expect(session.name).toBe("inv");
    // Issue #365 fallback: the parent (unknown) has no code state → the
    // #287 fresh-origin path (fetch + worktree off origin's default branch) —
    // the stale-clone repro ("37 commits behind") is gone.
    expect(session.cwd).toBe(layout.worktreeDir("proj", session.id));
    expect(registry.listWorkers({ projectId: "proj" })).toEqual([]);
    expect(git.invocations.map((inv) => inv.args[0])).toEqual(["fetch", "symbolic-ref", "worktree", "worktree"]);
    expect(git.invocations[3]?.args.at(-1)).toBe("origin/main");
    // The pane is a bare shell: the bootstrap types the persona launch (#290).
    expect(fake.sessions.get(session.tmuxSession)?.command).toEqual([]);
  });

  it("bases the spawn on the parent's checked-out commit when it has git state (inherit path)", async () => {
    const { manager, git } = makeManager();

    // A parent with a real worktree (worker-like kind): its cwd is recorded.
    const parent = await manager.spawnAgentKind("proj", { kind: "kiss-audit", parentSessionId: "p" });
    // The child (cheap kind) branches off the parent's commit — NOT origin:
    // the probe runs against the parent's recorded cwd, and NO fetch runs
    // (the parent's commit is local by construction).
    git.revParseHead = "abc123parent";
    git.invocations.length = 0;
    const child = await manager.spawnAgentKind("proj", { kind: "researcher", parentSessionId: parent.id, name: "nested" });
    expect(child.cwd).not.toBe(parent.cwd); // its own worktree
    const probe = git.invocations.find((inv) => inv.args[0] === "rev-parse");
    expect(probe?.cwd).toBe(parent.cwd);
    expect(git.invocations.map((inv) => inv.args[0])).toEqual(["rev-parse", "worktree", "worktree"]); // NO fetch
    const worktree = git.invocations.find((inv) => inv.args[1] === "add")?.args ?? [];
    expect(worktree[worktree.length - 1]).toBe("abc123parent");
  });

  it("falls back to fresh main when the parent's cwd is not a git repo (the orchestrator case)", async () => {
    const { manager, git } = makeManager();
    const orchestrator = await manager.ensureOrchestrator("proj");

    // The orchestrator's cwd (project dir) is not a git repo: the probe
    // fails loudly-insiduously and the spawn lands on up-to-date main.
    const session = await manager.spawnAgentKind("proj", { kind: "researcher", parentSessionId: orchestrator.id });
    expect(git.invocations.map((inv) => inv.args[0])).toEqual(["rev-parse", "fetch", "symbolic-ref", "worktree", "worktree"]);
    const worktree = git.invocations.find((inv) => inv.args[1] === "add")?.args ?? [];
    expect(worktree[worktree.length - 1]).toBe("origin/main");
    expect(session.cwd).toContain("worktrees");
  });

  it("spawns a worker-like kind in a fresh per-session worktree (issue #287 rules)", async () => {
    const { manager, git, layout } = makeManager();

    const session = await manager.spawnAgentKind("proj", {
      kind: "kiss-audit",
      parentSessionId: "sess-orch-1",
    });

    expect(session.agentKind).toBe("kiss-audit");
    expect(git.invocations.map((inv) => inv.args[0])).toEqual(["fetch", "symbolic-ref", "worktree", "worktree"]);
    const worktree = git.invocations[3]?.args ?? [];
    expect(worktree.slice(0, 3)).toEqual(["worktree", "add", "-b"]);
    expect(worktree[3]).toBe(`pideck/${session.id}`); // keyed by the unique session id
    expect(worktree[worktree.length - 1]).toBe("origin/main");
    expect(session.cwd).toBe(layout.worktreeDir("proj", session.id));
  });

  it("aborts cleanly when the tmux launch fails: no session record, worktree discarded", async () => {
    const fake = new FakeTmuxRunner();
    const git = new FakeGitRunner();
    const layout = new ProjectLayout(stateDir);
    const registry = new SessionRegistry(layout.sessionsFilePath());
    const tmux = new Tmux({
      runner: async (args) => {
        if (args.includes("new-session")) throw new Error("tmux exploded");
        return fake.run(args);
      },
    });
    const manager = new SessionManager({ tmux, registry, layout, git: git.asRunner() });

    await expect(
      manager.spawnAgentKind("proj", { kind: "devex-audit", parentSessionId: "p" }),
    ).rejects.toThrow("tmux exploded");
    expect(registry.listSessions({ projectId: "proj" })).toEqual([]);
    const removes = git.invocations.filter((inv) => inv.args[0] === "worktree" && inv.args[1] === "remove");
    expect(removes).toHaveLength(1);
    expect(removes[0]?.args).toContain("--force");
  });

  it("relaunches a kind pane as a bare shell in its recorded cwd (the bootstrap types the persona)", async () => {
    const { manager, fake } = makeManager();
    const session = await manager.spawnAgentKind("proj", {
      kind: "researcher",
      parentSessionId: "p",
    });

    // The user exits the pane; the relaunch re-creates it as a bare shell
    // in the recorded workspace — the bootstrap types the persona after.
    await manager.relaunchSession(session.id);
    const relaunched = fake.sessions.get(session.tmuxSession);
    expect(relaunched?.cwd).toBe(session.cwd);
    expect(relaunched?.command).toEqual([]);
  });
});
