/**
 * Agent-kind spawn mechanics (docs/agent-kinds.md, issues #297/#300/#302):
 * sessions — never worker records — with the preset persona command, the
 * per-kind workspace rules (fresh-origin worktree for worker-like audits,
 * project clone for cheap investigators), and command recording so
 * relaunch/reconcile re-run the identical pane.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectLayout } from "./layout.js";
import { SessionManager, resurrectionCommand } from "./manager.js";
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

const buildCommand = ({ sessionId, cwd }: { sessionId: string; cwd: string }) => [
  "env",
  `PD_SESSION_ID=${sessionId}`,
  "pi",
  "--append-system-prompt",
  path.join(cwd, "persona.md"),
];

describe("agent-kind spawn (docs/agent-kinds.md)", () => {
  it("spawns a cheap kind in the project clone: session record, no worker, no git", async () => {
    const { manager, git, registry } = makeManager();

    const session = await manager.spawnAgentKind("proj", {
      kind: "investigator",
      parentSessionId: "sess-caller-1",
      name: "inv",
      buildCommand,
    });

    // A session, not a worker: no workerId, kind + parent lineage recorded.
    expect(session.role).toBe("worker");
    expect(session.workerId).toBeNull();
    expect(session.agentKind).toBe("investigator");
    expect(session.parentSessionId).toBe("sess-caller-1");
    expect(session.name).toBe("inv");
    expect(session.cwd).toBe(stateDir && path.join(stateDir, "projects", "proj", "clone"));
    expect(registry.listWorkers({ projectId: "proj" })).toEqual([]);
    // Cheap kinds skip workspace preparation entirely (read-only in the clone).
    expect(git.invocations).toEqual([]);
    // The built command is both launched and recorded (relaunch/reconcile #27/#117).
    expect(session.command).toContain("pi");
    expect(session.command).toContain(`PD_SESSION_ID=${session.id}`);
  });

  it("spawns a worker-like kind in a fresh per-session worktree (issue #287 rules)", async () => {
    const { manager, git, layout } = makeManager();

    const session = await manager.spawnAgentKind("proj", {
      kind: "kiss-audit",
      parentSessionId: "sess-orch-1",
      buildCommand,
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
      manager.spawnAgentKind("proj", { kind: "devex-audit", parentSessionId: "p", buildCommand }),
    ).rejects.toThrow("tmux exploded");
    expect(registry.listSessions({ projectId: "proj" })).toEqual([]);
    const removes = git.invocations.filter((inv) => inv.args[0] === "worktree" && inv.args[1] === "remove");
    expect(removes).toHaveLength(1);
    expect(removes[0]?.args).toContain("--force");
  });

  it("aborts cleanly when the persona (buildCommand) fails: no session, no pane", async () => {
    const { manager, fake, registry } = makeManager();

    await expect(
      manager.spawnAgentKind("proj", {
        kind: "investigator",
        parentSessionId: "p",
        buildCommand: () => {
          throw new Error("persona template missing");
        },
      }),
    ).rejects.toThrow("persona template missing");
    expect(registry.listSessions({ projectId: "proj" })).toEqual([]);
    expect(fake.sessions.size).toBe(0);
  });

  it("relaunches from the recorded persona command: same argv, read-only flags intact", async () => {
    const { manager, fake } = makeManager();
    const readOnlyCommand = ({ sessionId, cwd }: { sessionId: string; cwd: string }) => [
      ...buildCommand({ sessionId, cwd }),
      "--exclude-tools",
      "edit,write",
    ];

    const session = await manager.spawnAgentKind("proj", {
      kind: "investigator",
      parentSessionId: "p",
      buildCommand: readOnlyCommand,
    });
    expect(session.command).toContain("--exclude-tools");

    // The user exits the pane; relaunch re-runs the recorded command through
    // the reboot-resilient guard (identical argv inside the guard, like workers).
    await manager.relaunchSession(session.id);
    const relaunched = fake.sessions.get(session.tmuxSession);
    expect(relaunched?.command).toEqual(resurrectionCommand(readOnlyCommand({ sessionId: session.id, cwd: session.cwd! })));
  });
});
