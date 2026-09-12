import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionSchema } from "@pideck/shared";
import { Tmux, TmuxError, type TmuxRunner } from "./tmux.js";
import { SessionRegistry } from "./registry.js";
import {
  archiveSession,
  reconcileWithTmux,
  spawnPiSession,
  type GitRunner,
} from "./spawn.js";

interface FakeTmuxState {
  alive: Set<string>;
  created: { args: string[] }[];
  killed: string[];
}

function fakeTmux(state: FakeTmuxState): Tmux {
  const runner: TmuxRunner = async (args) => {
    const [cmd, ...rest] = args;
    if (cmd === "has-session") {
      if (state.alive.has(rest[1]!)) return { stdout: "", stderr: "" };
      throw new TmuxError("no session", { args, exitCode: 1 });
    }
    if (cmd === "new-session") {
      state.created.push({ args });
      state.alive.add(args[3]!);
      return { stdout: "", stderr: "" };
    }
    if (cmd === "kill-session") {
      state.alive.delete(rest[1]!);
      state.killed.push(rest[1]!);
      return { stdout: "", stderr: "" };
    }
    if (cmd === "capture-pane") return { stdout: "pane log\nlast line", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return new Tmux({ runner, enterDelayMs: 0 });
}

interface FakeGitState {
  calls: string[][];
  /** Branches that "exist" in the clone. */
  branches: Set<string>;
}

function fakeGit(state: FakeGitState): GitRunner {
  return async (args, options) => {
    state.calls.push([...args]);
    const [cmd, ...rest] = args;
    if (cmd === "show-ref") {
      const ref = rest.at(-1)!.replace("refs/heads/", "");
      if (state.branches.has(ref)) return "";
      throw new TmuxError("no such ref", { args, exitCode: 1 });
    }
    if (cmd === "symbolic-ref") return "origin/main\n";
    if (cmd === "fetch") return "";
    if (cmd === "rev-parse") return "abc123\n";
    if (cmd === "worktree") {
      // `worktree add -b <branch> <path> <base>` — register the branch.
      if (rest[0] === "add" && rest[1] === "-b") state.branches.add(rest[2]!);
      return "";
    }
    throw new Error(`unexpected git command: ${args.join(" ")} (cwd ${options?.cwd})`);
  };
}

let stateDir: string;
let cloneDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "pideck-spawn-"));
  cloneDir = mkdtempSync(join(tmpdir(), "pideck-clone-"));
});

describe("spawnPiSession", () => {
  it("spawns a worker in a fresh worktree on pideck/issue-<n> from the default branch", async () => {
    const tmuxState: FakeTmuxState = { alive: new Set(), created: [], killed: [] };
    const gitState: FakeGitState = { calls: [], branches: new Set() };
    const deps = {
      tmux: fakeTmux(tmuxState),
      registry: new SessionRegistry(stateDir),
      stateDir,
      git: fakeGit(gitState),
    };

    const session = await spawnPiSession(deps, {
      persona: "worker",
      projectId: "proj",
      cwd: cloneDir,
      systemPrompt: "You are a worker.",
      model: "anthropic/claude",
      env: { GH_TOKEN: "t" },
      issueNumber: 42,
    });

    expect(gitState.calls).toEqual([
      ["show-ref", "--verify", "--quiet", "refs/heads/pideck/issue-42"],
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      ["worktree", "add", "-b", "pideck/issue-42", join(stateDir, "worktrees", session.id), "main"],
    ]);

    const create = tmuxState.created[0]!.args;
    expect(create.slice(0, 8)).toEqual([
      "new-session",
      "-d",
      "-s",
      `pideck-${session.id}`,
      "-n",
      "worker",
      "-c",
      join(stateDir, "worktrees", session.id),
    ]);
    // env wrapper: ["sh", "-c", script, "sh", ...command] follows the new-session args
    const script = create[10]!;
    expect(script).toContain("PD_SESSION_ID");
    expect(script).toContain("GH_TOKEN='t'");
    expect(create.slice(12)).toEqual([
      "pi",
      "--append-system-prompt",
      expect.any(String),
      "--model",
      "anthropic/claude",
    ]);

    const promptFile = create[14]!;
    expect(readFileSync(promptFile, "utf8")).toBe("You are a worker.");

    expect(deps.registry.get(session.id)).toEqual(session);
    expect(session.issueNumber).toBe(42);
    expect(session.model).toBe("anthropic/claude");
  });

  it("reuses an existing issue branch instead of resetting it", async () => {
    const gitState: FakeGitState = { calls: [], branches: new Set(["pideck/issue-42"]) };
    const deps = {
      tmux: fakeTmux({ alive: new Set(), created: [], killed: [] }),
      registry: new SessionRegistry(stateDir),
      stateDir,
      git: fakeGit(gitState),
    };
    await spawnPiSession(deps, {
      persona: "worker",
      projectId: "proj",
      cwd: cloneDir,
      systemPrompt: "p",
      model: null,
      issueNumber: 42,
    });
    expect(gitState.calls).toEqual([
      ["show-ref", "--verify", "--quiet", "refs/heads/pideck/issue-42"],
      ["worktree", "add", expect.any(String), "pideck/issue-42"],
    ]);
  });

  it("spawns a reviewer in a detached worktree of the PR head", async () => {
    const gitState: FakeGitState = { calls: [], branches: new Set() };
    const deps = {
      tmux: fakeTmux({ alive: new Set(), created: [], killed: [] }),
      registry: new SessionRegistry(stateDir),
      stateDir,
      git: fakeGit(gitState),
    };
    const session = await spawnPiSession(deps, {
      persona: "reviewer",
      projectId: "proj",
      cwd: cloneDir,
      systemPrompt: "review",
      model: null,
      prNumber: 7,
    });
    expect(gitState.calls).toEqual([
      ["fetch", "origin", "pull/7/head"],
      ["worktree", "add", "--detach", join(stateDir, "worktrees", session.id), "FETCH_HEAD"],
    ]);
    expect(session.prNumber).toBe(7);
  });

  it("spawns an orchestrator directly in the clone with no git work", async () => {
    const gitState: FakeGitState = { calls: [], branches: new Set() };
    const tmuxState: FakeTmuxState = { alive: new Set(), created: [], killed: [] };
    const deps = {
      tmux: fakeTmux(tmuxState),
      registry: new SessionRegistry(stateDir),
      stateDir,
      git: fakeGit(gitState),
    };
    const session = await spawnPiSession(deps, {
      persona: "orchestrator",
      projectId: "proj",
      cwd: cloneDir,
      systemPrompt: "orchestrate",
      model: null,
    });
    expect(gitState.calls).toEqual([]);
    const create = tmuxState.created[0]!.args;
    expect(create[7]).toBe(cloneDir);
    expect(create.slice(12)).toEqual(["pi", "--append-system-prompt", expect.any(String)]);
    expect(create.join(" ")).not.toContain("--model");
    expect(session.model).toBeNull();
  });
});

describe("archiveSession", () => {
  function setup() {
    const tmuxState: FakeTmuxState = { alive: new Set(), created: [], killed: [] };
    const gitState: FakeGitState = { calls: [], branches: new Set() };
    const registry = new SessionRegistry(stateDir);
    return {
      tmuxState,
      gitState,
      registry,
      deps: {
        tmux: fakeTmux(tmuxState),
        registry,
        stateDir,
        git: fakeGit(gitState),
        cloneDir,
      },
    };
  }

  it("captures scrollback, kills tmux, removes the worktree, archives the record", async () => {
    const { deps, tmuxState, registry } = setup();
    const session = SessionSchema.parse({
      id: "s1",
      persona: "worker",
      projectId: "proj",
      tmuxSession: "pideck-s1",
      spawnedAt: new Date().toISOString(),
      model: null,
    });
    registry.add(session);
    tmuxState.alive.add("pideck-s1");
    const worktree = join(stateDir, "worktrees", "s1");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(join(stateDir, "system-prompts"), { recursive: true });
    writeFileSync(join(worktree, "file.txt"), "x");
    writeFileSync(join(stateDir, "system-prompts", "s1.md"), "p");

    const archived = await archiveSession(deps, session);

    expect(readFileSync(join(stateDir, "logs", "s1.log"), "utf8")).toBe("pane log\nlast line\n");
    expect(tmuxState.killed).toEqual(["pideck-s1"]);
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(join(stateDir, "system-prompts", "s1.md"))).toBe(false);
    expect(archived.archivedAt).toEqual(expect.any(String));
    expect(registry.get("s1")?.archivedAt).toEqual(archived.archivedAt);
  });

  it("skips capture and kill when the pane is already gone", async () => {
    const { deps, tmuxState, gitState, registry } = setup();
    const session = SessionSchema.parse({
      id: "s2",
      persona: "orchestrator",
      projectId: null,
      tmuxSession: "pideck-s2",
      spawnedAt: new Date().toISOString(),
      model: null,
    });
    registry.add(session);
    const archived = await archiveSession(deps, session);
    expect(tmuxState.killed).toEqual([]);
    expect(existsSync(join(stateDir, "logs", "s2.log"))).toBe(false);
    expect(archived.archivedAt).toEqual(expect.any(String));
    expect(gitState.calls.some((c) => c[0] === "worktree")).toBe(true);
  });
});

describe("reconcileWithTmux", () => {
  it("reports non-archived records whose tmux session is gone, without archiving them", async () => {
    const registry = new SessionRegistry(stateDir);
    const alive = SessionSchema.parse({
      id: "alive",
      persona: "worker",
      projectId: "proj",
      tmuxSession: "pideck-alive",
      spawnedAt: new Date().toISOString(),
      model: null,
    });
    const gone = SessionSchema.parse({
      id: "gone",
      persona: "worker",
      projectId: "proj",
      tmuxSession: "pideck-gone",
      spawnedAt: new Date().toISOString(),
      model: null,
    });
    const archived = SessionSchema.parse({
      id: "archived",
      persona: "worker",
      projectId: "proj",
      tmuxSession: "pideck-archived",
      spawnedAt: new Date().toISOString(),
      model: null,
      archivedAt: new Date().toISOString(),
    });
    registry.add(alive);
    registry.add(gone);
    registry.add(archived);

    const tmux = fakeTmux({ alive: new Set(["pideck-alive"]), created: [], killed: [] });
    const result = await reconcileWithTmux(registry, tmux);

    expect(result.dead.map((s) => s.id)).toEqual(["gone"]);
    expect(registry.get("gone")?.archivedAt).toBeUndefined();
  });
});