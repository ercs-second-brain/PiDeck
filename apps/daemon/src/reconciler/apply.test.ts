import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectSchema, ProjectSettingsSchema, SessionSchema } from "@pideck/shared";
import { SessionRegistry } from "../sessions/registry.js";
import { Tmux, TmuxError, type TmuxRunner } from "../sessions/tmux.js";
import { applyActions, type ApplyDeps, type PromptSource } from "./apply.js";
import type { IssueFacts, PrFacts } from "./read.js";
import { Trace } from "./trace.js";

const project = ProjectSchema.parse({
  id: "my-api",
  name: "My API",
  repoUrl: "https://github.com/acme/my-api",
  owner: "acme",
  repo: "my-api",
  defaultBranch: "main",
  path: "/tmp/my-api",
});

const settings = ProjectSettingsSchema.parse({});

function issue(): IssueFacts {
  return {
    number: 1,
    title: "Add rate limiting",
    url: "https://github.com/acme/my-api/issues/1",
    assignees: ["acme-worker"],
    openBlockers: 0,
    comments: [],
  };
}

function prFact(): PrFacts {
  return {
    number: 11,
    headBranch: "pideck/issue-1",
    headSha: "sha-1",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    ciStatus: "ok",
    failingChecks: [],
    green: true,
    issueNumber: 1,
    reviews: [],
    reviewComments: [],
    prComments: [],
  };
}

function fakeTmux(alive: string[] = []) {
  const calls: string[][] = [];
  const live = new Set(alive);
  const runner: TmuxRunner = async (args) => {
    calls.push(args);
    if (args[0] === "has-session" || args[0] === "send-keys") {
      const name = args[args.indexOf("-t") + 1] ?? "";
      // An empty `alive` list means the fake tracks no panes: everything lives.
      if (!live.has(name) && live.size > 0) {
        throw new TmuxError(`can't find session ${name}`, { args, exitCode: 1, stderr: "no such session" });
      }
      if (args[0] === "has-session") return { stdout: "", stderr: "" };
    }
    if (args[0] === "capture-pane") {
      return { stdout: "pane scrollback", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  const tmux = new Tmux({ runner, enterDelayMs: 0 });
  return { tmux, calls };
}

/** Reassembles the lines Tmux.sendLine typed into panes. */
function sentLines(calls: string[][]): string[] {
  const lines: string[] = [];
  let buffer = "";
  for (const args of calls) {
    if (args[0] !== "send-keys") continue;
    if (args.includes("Enter")) {
      lines.push(buffer);
      buffer = "";
    } else if (args.includes("-H")) {
      const hex = args.slice(args.indexOf("-H") + 1).join("");
      buffer += Buffer.from(hex, "hex").toString("utf8");
    }
  }
  return lines;
}

const prompts: PromptSource = {
  systemPrompt: (persona, vars) => `${persona}-prompt ${vars.SESSION_ID ?? vars.ORCHESTRATOR_SESSION_ID ?? ""}`,
  model: () => "test-model",
};

describe("applyActions", () => {
  let stateDir: string;
  let registry: SessionRegistry;
  let deps: ApplyDeps;
  let tmuxCalls: string[][];
  let gitCalls: string[][];
  let changes: number;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "pideck-apply-"));
    registry = new SessionRegistry(stateDir);
    gitCalls = [];
    changes = 0;
    const { tmux, calls } = fakeTmux();
    tmuxCalls = calls;
    deps = {
      tmux,
      registry,
      stateDir,
      prompts,
      trace: new Trace(stateDir),
      notifyChange: () => {
        changes++;
      },
      log: () => {},
      git: async (args) => {
        gitCalls.push(args);
        return "";
      },
    };
  });

  afterEach(() => {
    rmDir(stateDir);
  });

  it("spawns a worker: registry, prompt file with the real session id, and the spawn delivery", async () => {
    const tally = { spawned: 0, archived: 0, delivered: 0, errors: 0 };
    await applyActions(
      deps,
      { project, settings, reviewToken: null },
      [{ kind: "spawn-worker", issue: issue(), initial: { lastDeliveredIssueCommentId: 7 } }],
      tally,
    );

    expect(tally).toMatchObject({ spawned: 1, errors: 0 });
    const workers = registry.list({ persona: "worker" });
    expect(workers).toHaveLength(1);
    const worker = workers[0]!;
    expect(worker.issueNumber).toBe(1);
    expect(worker.model).toBe("test-model");
    expect(worker.lastDeliveredIssueCommentId).toBe(7);

    const promptFile = join(stateDir, "system-prompts", `${worker.id}.md`);
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("worker-prompt");
    expect(prompt).toContain(worker.id);
    expect(prompt).not.toContain("{{SESSION_ID}}");

    expect(sentLines(tmuxCalls).join("\n")).toContain('issue #1 "Add rate limiting"');
    expect(sentLines(tmuxCalls).join("\n")).toContain("pideck/issue-1");
    expect(changes).toBeGreaterThan(0);

    const spawns = new Trace(stateDir).read(worker.id).filter((entry) => entry.kind === "spawn");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({ kind: "spawn", detail: "spawned worker for issue #1" });
  });

  it("spawns a reviewer with the review token as GH_TOKEN", async () => {
    const tally = { spawned: 0, archived: 0, delivered: 0, errors: 0 };
    await applyActions(
      deps,
      { project, settings, reviewToken: { username: "acme-review", token: "rev-token" } },
      [{ kind: "spawn-reviewer", pr: prFact(), initial: { lastPromptedHeadSha: "sha-1" } }],
      tally,
    );

    const reviewers = registry.list({ persona: "reviewer" });
    expect(reviewers).toHaveLength(1);
    const reviewer = reviewers[0]!;
    expect(reviewer.prNumber).toBe(11);
    expect(reviewer.lastPromptedHeadSha).toBe("sha-1");

    const createCall = tmuxCalls.find((args) => args[0] === "new-session");
    expect(createCall?.join(" ")).toContain("GH_TOKEN=");
    expect(sentLines(tmuxCalls).join("\n")).toContain("file exactly one review");
  });

  it("refuses to spawn a reviewer without a review account", async () => {
    const tally = { spawned: 0, archived: 0, delivered: 0, errors: 0 };
    await applyActions(
      deps,
      { project, settings, reviewToken: null },
      [{ kind: "spawn-reviewer", pr: prFact(), initial: {} }],
      tally,
    );
    expect(tally).toMatchObject({ spawned: 0, errors: 1 });
    expect(registry.list({ persona: "reviewer" })).toHaveLength(0);
  });

  it("spawns the orchestrator with the briefing in the prompt file and no typed delivery", async () => {
    const tally = { spawned: 0, archived: 0, delivered: 0, errors: 0 };
    await applyActions(
      deps,
      { project, settings, reviewToken: null },
      [{ kind: "spawn-orchestrator", briefing: "Briefing for My API: live: (none)." }],
      tally,
    );

    const orchestrators = registry.list({ persona: "orchestrator" });
    expect(orchestrators).toHaveLength(1);
    const orchestrator = orchestrators[0]!;
    const prompt = readFileSync(join(stateDir, "system-prompts", `${orchestrator.id}.md`), "utf8");
    expect(prompt).toContain("orchestrator-prompt");
    expect(prompt).toContain("Briefing for My API: live: (none).");
    expect(prompt).toContain(orchestrator.id);
    expect(prompt).not.toContain("{{ORCHESTRATOR_SESSION_ID}}");
    expect(sentLines(tmuxCalls)).toEqual([]);
    expect(tally).toMatchObject({ spawned: 1, delivered: 0, errors: 0 });
  });

  it("delivers into a live pane and only then writes the watermark", async () => {
    const target = SessionSchema.parse({
        id: "s-worker",
        persona: "worker",
        projectId: "my-api",
        issueNumber: 1,
        tmuxSession: "pideck-s-worker",
        spawnedAt: "2025-06-01T00:00:00Z",
        model: null,
      });
    registry.add(target);
    const tally = { spawned: 0, archived: 0, delivered: 0, errors: 0 };
    await applyActions(
      deps,
      { project, settings, reviewToken: null },
      [
        {
          kind: "deliver",
          target,
          text: "CI failed: build",
          watermark: { sessionId: target.id, patch: { fixAttempts: 1 } },
        },
      ],
      tally,
    );

    expect(sentLines(tmuxCalls)).toContain("CI failed: build");
    expect(registry.get("s-worker")!.fixAttempts).toBe(1);
    expect(tally.delivered).toBe(1);

    const trace = new Trace(stateDir);
    const deliveries = trace.read("s-worker").filter((entry) => entry.kind === "delivery");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ kind: "delivery", text: "CI failed: build", watermark: { fixAttempts: 1 } });
  });

  it("archives a live pane: captured log, killed session, archived record", async () => {
    const session = SessionSchema.parse({
        id: "s-worker",
        persona: "worker",
        projectId: "my-api",
        issueNumber: 1,
        tmuxSession: "pideck-s-worker",
        spawnedAt: "2025-06-01T00:00:00Z",
        model: null,
      });
    registry.add(session);
    const { tmux, calls } = fakeTmux(["pideck-s-worker"]);
    deps = { ...deps, tmux };
    const tally = { spawned: 0, archived: 0, delivered: 0, errors: 0 };
    await applyActions(deps, { project, settings, reviewToken: null }, [{ kind: "archive", session, reason: "test" }], tally);

    expect(existsSync(join(stateDir, "logs", "s-worker.log"))).toBe(true);
    expect(registry.get("s-worker")!.archivedAt).toBeDefined();
    expect(calls.some((args) => args[0] === "kill-session")).toBe(true);
    expect(changes).toBeGreaterThan(0);

    const archives = new Trace(stateDir).read("s-worker").filter((entry) => entry.kind === "archive");
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatchObject({ kind: "archive", detail: "test" });
  });

  it("fast-forwards the project clone when a worker is archived", async () => {
    const session = SessionSchema.parse({
        id: "s-worker",
        persona: "worker",
        projectId: "my-api",
        issueNumber: 1,
        tmuxSession: "pideck-s-worker",
        spawnedAt: "2025-06-01T00:00:00Z",
        model: null,
      });
    registry.add(session);
    const { tmux } = fakeTmux(["pideck-s-worker"]);
    deps = { ...deps, tmux };
    const tally = { spawned: 0, archived: 0, delivered: 0, errors: 0 };
    await applyActions(
      deps,
      { project, settings, reviewToken: null },
      [{ kind: "archive", session, reason: "issue #1 closed or merged" }],
      tally,
    );

    expect(gitCalls).toEqual([
      ["fetch", "origin"],
      ["merge", "--ff-only", "@{upstream}"],
    ]);
    expect(tally).toMatchObject({ archived: 1, errors: 0 });
  });

  it("archives a worker even when the project clone cannot be fast-forwarded", async () => {
    const session = SessionSchema.parse({
        id: "s-worker",
        persona: "worker",
        projectId: "my-api",
        issueNumber: 1,
        tmuxSession: "pideck-s-worker",
        spawnedAt: "2025-06-01T00:00:00Z",
        model: null,
      });
    registry.add(session);
    const { tmux } = fakeTmux(["pideck-s-worker"]);
    const logs: string[] = [];
    deps = {
      ...deps,
      tmux,
      git: async (args) => {
        if (args[0] === "merge") throw new Error("local changes would be overwritten");
        return "";
      },
      log: (line) => logs.push(line),
    };
    const tally = { spawned: 0, archived: 0, delivered: 0, errors: 0 };
    await applyActions(
      deps,
      { project, settings, reviewToken: null },
      [{ kind: "archive", session, reason: "issue #1 closed or merged" }],
      tally,
    );

    expect(registry.get("s-worker")!.archivedAt).toBeDefined();
    expect(logs.join("\n")).toContain("clone refresh skipped");
    expect(tally).toMatchObject({ archived: 1, errors: 0 });
  });

  it("counts action failures without stopping the rest", async () => {
    deps = { ...deps, ...fakeTmux(["someone-else"]) };
    const target = SessionSchema.parse({
      id: "s-worker",
      persona: "worker",
      projectId: "my-api",
      issueNumber: 1,
      tmuxSession: "pideck-gone",
      spawnedAt: "2025-06-01T00:00:00Z",
      model: null,
    });
    registry.add(target);
    const tally = { spawned: 0, archived: 0, delivered: 0, errors: 0 };
    await applyActions(
      deps,
      { project, settings, reviewToken: null },
      [
        { kind: "deliver", target, text: "lost" },
        { kind: "watermarks", sessionId: target.id, patch: { fixAttempts: 2 } },
      ],
      tally,
    );

    expect(tally.errors).toBe(1);
    expect(tally.delivered).toBe(0);
    expect(registry.get("s-worker")!.fixAttempts).toBe(2);
  });
});

function rmDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
