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
  /** Basename of each pane's current command; defaults to `node` (pi running). */
  paneCommands?: Map<string, string>;
  /** When set, `new-session` fails like a tmux error. */
  failCreate?: boolean;
}

function fakeTmux(state: FakeTmuxState): Tmux {
  const runner: TmuxRunner = async (args) => {
    const [cmd, ...rest] = args;
    if (cmd === "has-session") {
      if (state.alive.has(rest[1]!)) return { stdout: "", stderr: "" };
      throw new TmuxError("no session", { args, exitCode: 1 });
    }
    if (cmd === "new-session") {
      if (state.failCreate) throw new TmuxError("create refused", { args, exitCode: 1 });
      state.created.push({ args });
      state.alive.add(args[7]!);
      return { stdout: "", stderr: "" };
    }
    if (cmd === "kill-session") {
      state.alive.delete(rest[1]!);
      state.killed.push(rest[1]!);
      return { stdout: "", stderr: "" };
    }
    if (cmd === "capture-pane") return { stdout: "pane log\nlast line", stderr: "" };
    if (cmd === "display-message") {
      return { stdout: `${state.paneCommands?.get(rest[2]!) ?? "node"}\n`, stderr: "" };
    }
    if (cmd === "list-sessions") return { stdout: [...state.alive].join("\n"), stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return new Tmux({ runner, enterDelayMs: 0, waitPollMs: 5, waitQuietMs: 0 });
}

interface FakeGitState {
  calls: string[][];
  /** Branches that exist on the session clone's remote. */
  branches: Set<string>;
}

function fakeGit(state: FakeGitState): GitRunner {
  return async (args) => {
    state.calls.push([...args]);
    const [cmd, ...rest] = args;
    if (cmd === "show-ref") {
      const ref = rest.at(-1)!.replace("refs/remotes/origin/", "");
      if (state.branches.has(ref)) return "";
      throw new TmuxError("no such ref", { args, exitCode: 1 });
    }
    if (cmd === "symbolic-ref") return "origin/main\n";
    if (cmd === "fetch" || cmd === "clone" || cmd === "remote" || cmd === "checkout") return "";
    if (cmd === "rev-parse") return "abc123\n";
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };
}

const REPO_URL = "https://github.com/acme/widget";

let stateDir: string;
let cloneDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "pideck-spawn-"));
  cloneDir = mkdtempSync(join(tmpdir(), "pideck-clone-"));
});

describe("spawnPiSession", () => {
  it("spawns a worker in its own clone, basing pideck/issue-<n> on the default branch when it does not exist upstream", async () => {
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
      repoUrl: REPO_URL,
      systemPrompt: "You are a worker.",
      model: "anthropic/claude",
      env: { GH_TOKEN: "t" },
      issueNumber: 42,
    });

    const repo = join(stateDir, "sessions", session.id, "repo");
    expect(gitState.calls).toEqual([
      ["clone", cloneDir, repo],
      ["remote", "set-url", "origin", REPO_URL],
      ["fetch", "origin"],
      ["show-ref", "--verify", "--quiet", "refs/remotes/origin/pideck/issue-42"],
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      ["checkout", "-B", "pideck/issue-42", "origin/main"],
    ]);

    const create = tmuxState.created[0]!.args;
    expect(create.slice(0, 12)).toEqual([
      "new-session",
      "-d",
      "-x",
      "200",
      "-y",
      "50",
      "-s",
      `pideck-${session.id}`,
      "-n",
      "worker",
      "-c",
      repo,
    ]);
    // env wrapper: ["sh", "-c", script, "sh", ...command] follows the new-session args
    const script = create[14]!;
    expect(script).toContain("PD_SESSION_ID");
    expect(script).toContain("GH_TOKEN='t'");
    expect(create.slice(16)).toEqual([
      "pi",
      "--session-dir",
      join(stateDir, "pi-sessions", session.id),
      "--append-system-prompt",
      expect.any(String),
      "--model",
      "anthropic/claude",
    ]);

    const promptFile = create[20]!;
    expect(readFileSync(promptFile, "utf8")).toBe("You are a worker.");
    expect(existsSync(join(stateDir, "pi-sessions", session.id))).toBe(true);

    expect(deps.registry.get(session.id)).toEqual(session);
    expect(session.issueNumber).toBe(42);
    expect(session.model).toBe("anthropic/claude");
  });

  it("checks out the upstream issue branch when it exists, keeping in-progress work", async () => {
    const gitState: FakeGitState = { calls: [], branches: new Set(["pideck/issue-42"]) };
    const deps = {
      tmux: fakeTmux({ alive: new Set(), created: [], killed: [] }),
      registry: new SessionRegistry(stateDir),
      stateDir,
      git: fakeGit(gitState),
    };
    const session = await spawnPiSession(deps, {
      persona: "worker",
      projectId: "proj",
      cwd: cloneDir,
      repoUrl: REPO_URL,
      systemPrompt: "p",
      model: null,
      issueNumber: 42,
    });
    expect(gitState.calls).toEqual([
      ["clone", cloneDir, join(stateDir, "sessions", session.id, "repo")],
      ["remote", "set-url", "origin", REPO_URL],
      ["fetch", "origin"],
      ["show-ref", "--verify", "--quiet", "refs/remotes/origin/pideck/issue-42"],
      ["checkout", "pideck/issue-42"],
    ]);
  });

  it("waits for the pane to settle before returning the session", async () => {
    let reads = 0;
    // The TUI redraws for the first three reads, then settles.
    const runner: TmuxRunner = async (args) => {
      if (args[0] === "capture-pane") {
        reads++;
        return { stdout: reads <= 3 ? `screen ${reads}` : "screen 3", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const tmux = new Tmux({ runner, enterDelayMs: 0, waitPollMs: 5, waitQuietMs: 0 });
    const deps = {
      tmux,
      registry: new SessionRegistry(stateDir),
      stateDir,
      git: fakeGit({ calls: [], branches: new Set() }),
    };
    await spawnPiSession(deps, {
      persona: "orchestrator",
      projectId: "proj",
      cwd: cloneDir,
      systemPrompt: "x",
      model: null,
    });
    // Settled only after two consecutive equal reads: at least 4 reads.
    expect(reads).toBeGreaterThanOrEqual(4);
  });

  it("proceeds anyway when the pane never settles", async () => {
    const runner: TmuxRunner = async (args) => {
      if (args[0] === "capture-pane") {
        return { stdout: `screen ${Math.random()}`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const tmux = new Tmux({
      runner,
      enterDelayMs: 0,
      waitPollMs: 5,
      waitQuietMs: 0,
      waitTimeoutMs: 40,
      log: () => {},
    });
    const deps = {
      tmux,
      registry: new SessionRegistry(stateDir),
      stateDir,
      git: fakeGit({ calls: [], branches: new Set() }),
    };
    const session = await spawnPiSession(deps, {
      persona: "orchestrator",
      projectId: "proj",
      cwd: cloneDir,
      systemPrompt: "x",
      model: null,
    });
    expect(deps.registry.get(session.id)).toEqual(session);
  });

  it("registers the session record even when the pane creation fails", async () => {
    const tmuxState: FakeTmuxState = {
      alive: new Set(),
      created: [],
      killed: [],
      failCreate: true,
    };
    const registry = new SessionRegistry(stateDir);
    const deps = {
      tmux: fakeTmux(tmuxState),
      registry,
      stateDir,
      git: fakeGit({ calls: [], branches: new Set() }),
    };
    await expect(
      spawnPiSession(deps, {
        persona: "orchestrator",
        projectId: "proj",
        cwd: cloneDir,
        systemPrompt: "x",
        model: null,
      }),
    ).rejects.toThrow();
    expect(tmuxState.created).toEqual([]);
    // The record exists before the pane: the next reconciliation sees a
    // registered session with no pane and archives it — no orphan.
    expect(registry.list({ archived: false })).toHaveLength(1);
  });

  it("spawns a reviewer in its own clone, detached at the PR head", async () => {
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
      repoUrl: REPO_URL,
      systemPrompt: "review",
      model: null,
      prNumber: 7,
    });
    expect(gitState.calls).toEqual([
      ["clone", cloneDir, join(stateDir, "sessions", session.id, "repo")],
      ["remote", "set-url", "origin", REPO_URL],
      ["fetch", "origin", "pull/7/head"],
      ["checkout", "--detach", "FETCH_HEAD"],
    ]);
    expect(session.prNumber).toBe(7);
  });

  it("spawns an orchestrator directly in the project clone with no git work", async () => {
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
    expect(create[11]).toBe(cloneDir);
    expect(create.slice(16)).toEqual([
      "pi",
      "--session-dir",
      join(stateDir, "pi-sessions", session.id),
      "--append-system-prompt",
      expect.any(String),
    ]);
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
      },
    };
  }

  it("captures scrollback, kills tmux, removes the session directory, archives the record", async () => {
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
    const sessionDir = join(stateDir, "sessions", "s1");
    mkdirSync(join(sessionDir, "repo"), { recursive: true });
    mkdirSync(join(stateDir, "system-prompts"), { recursive: true });
    mkdirSync(join(stateDir, "pi-sessions", "s1"), { recursive: true });
    writeFileSync(join(sessionDir, "repo", "file.txt"), "x");
    writeFileSync(join(stateDir, "system-prompts", "s1.md"), "p");
    writeFileSync(join(stateDir, "pi-sessions", "s1", "session.jsonl"), "{}\n");
    mkdirSync(join(stateDir, "traces"), { recursive: true });
    writeFileSync(join(stateDir, "traces", "s1.jsonl"), "{\"at\":\"x\"}\n");

    const archived = await archiveSession(deps, session);

    expect(readFileSync(join(stateDir, "logs", "s1.log"), "utf8")).toBe("pane log\nlast line\n");
    expect(tmuxState.killed).toEqual(["pideck-s1"]);
    expect(existsSync(sessionDir)).toBe(false);
    expect(existsSync(join(stateDir, "system-prompts", "s1.md"))).toBe(false);
    expect(existsSync(join(stateDir, "pi-sessions", "s1"))).toBe(false);
    // The trace outlives archive, sitting next to the captured pane log.
    expect(existsSync(join(stateDir, "traces", "s1.jsonl"))).toBe(true);
    expect(readFileSync(join(stateDir, "traces", "s1.jsonl"), "utf8")).toBe("{\"at\":\"x\"}\n");
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
    expect(gitState.calls).toEqual([]);
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
    expect(result.orphanTmuxSessions).toEqual([]);
    expect(registry.get("gone")?.archivedAt).toBeUndefined();
  });

  it("reports a pane whose pi exited and only the wrapper's shell remains as dead", async () => {
    const registry = new SessionRegistry(stateDir);
    const running = SessionSchema.parse({
      id: "running",
      persona: "worker",
      projectId: "proj",
      tmuxSession: "pideck-running",
      spawnedAt: new Date().toISOString(),
      model: null,
    });
    const exited = SessionSchema.parse({
      id: "exited",
      persona: "worker",
      projectId: "proj",
      tmuxSession: "pideck-exited",
      spawnedAt: new Date().toISOString(),
      model: null,
    });
    registry.add(running);
    registry.add(exited);

    const tmux = fakeTmux({
      alive: new Set(["pideck-running", "pideck-exited"]),
      created: [],
      killed: [],
      paneCommands: new Map([
        ["pideck-running", "node"],
        ["pideck-exited", "zsh"],
      ]),
    });
    const result = await reconcileWithTmux(registry, tmux);
    expect(result.dead.map((s) => s.id)).toEqual(["exited"]);
  });

  it("archives pideck-* panes with no registry record: capture to logs, then kill", async () => {
    const registry = new SessionRegistry(stateDir);
    const known = SessionSchema.parse({
      id: "known",
      persona: "worker",
      projectId: "proj",
      tmuxSession: "pideck-known",
      spawnedAt: new Date().toISOString(),
      model: null,
    });
    registry.add(known);
    const tmuxState: FakeTmuxState = {
      alive: new Set(["pideck-known", "pideck-orphan", "other-agent"]),
      created: [],
      killed: [],
    };
    const tmux = fakeTmux(tmuxState);
    const logs: string[] = [];
    const result = await reconcileWithTmux(registry, tmux, { stateDir, log: (l) => logs.push(l) });

    expect(result.orphanTmuxSessions).toEqual(["pideck-orphan"]);
    expect(readFileSync(join(stateDir, "logs", "pideck-orphan.log"), "utf8")).toBe("pane log\nlast line\n");
    expect(tmuxState.killed).toEqual(["pideck-orphan"]);
    expect(logs.join("\n")).toContain("orphan pane pideck-orphan");
  });
});