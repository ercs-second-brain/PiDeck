/**
 * Agent-kind spawn routes (docs/agent-kinds.md, issues #297/#300/#302):
 * `POST /api/projects/:projectId/spawn` with a `kind` body (the CLI path,
 * merged in #306) and the contract endpoint
 * `POST /api/projects/:projectId/spawn-agent` (the webapp menu path).
 * Covers parent-of-any-role resolution (explicit → discovered caller →
 * orchestrator fallback for audits; caller-routed kinds reject), persona
 * rendering, read-only enforcement, issue #56 question gating, and the
 * worker-concurrency cap for worker-like kinds.
 */

import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionSchema, workerSchema } from "@pideck/shared";

import type { PiRunner } from "../agent/pi-auth.js";
import type { ProcessInfo } from "../sessions/caller-discovery.js";
import { startContractServer, type ContractServer } from "./contract-fixtures.js";

let server: ContractServer;

beforeAll(async () => {
  server = await startContractServer();
});

afterAll(async () => {
  await server?.close();
});

/** Registers a fresh project (its own clone dir) and returns its id. */
async function registerProject(id: string, settings: { workerConcurrency?: number } = {}): Promise<string> {
  const { daemon } = server;
  await daemon.services.projects.register({
    mode: "clone",
    repoUrl: `https://github.com/ak/${id}`,
    ...(settings.workerConcurrency !== undefined ? { settings } : {}),
  });
  return `ak-${id}`;
}

/** The spawned session's rendered persona file, for placeholder assertions. */
function personaFile(projectId: string, sessionId: string): string {
  const file = `${server.daemon.stateDir}/projects/${projectId}/agent-prompt-${sessionId}.md`;
  expect(existsSync(file), `${file} should exist`).toBe(true);
  return readFileSync(file, "utf8");
}

describe("agent-kind spawn: persona, question, report target (docs/agent-kinds.md)", () => {
  it("spawns a researcher with an explicit parent and delivers the question (pi auth ready)", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("inv1");
    const parent = await daemon.services.sessions.ensureOrchestrator(projectId);

    const res = await api("POST", `/api/projects/${projectId}/spawn`, {
      kind: "researcher",
      name: "inv",
      question: "why is spawn slow?",
      parentSessionId: parent.id,
    });
    expect(res.status).toBe(201);
    // Agent-kind sessions are sessions, not workers (the #306 CLI contract).
    const session = sessionSchema.parse(res.json);
    expect(session.agentKind).toBe("researcher");
    expect(session.parentSessionId).toBe(parent.id);
    expect(session.workerId).toBeNull();
    expect(session.name).toBe("inv");

    // The question was typed into the pane (pi auth ready in the fixture).
    const pane = daemon.tmux.sentBytes(session.tmuxSession).toString("utf8");
    expect(pane).toContain("why is spawn slow?");

    // The persona is rendered: the report route carries the caller's id,
    // PROJECT_PATH is the session's working directory (the clone).
    const persona = personaFile(projectId, session.id);
    expect(persona).toContain(`pideck send --session ${parent.id}`);
    expect(persona).toContain(session.cwd!);
    expect(persona).not.toContain("{{PARENT_SESSION_ID}}");
  });
});

describe("agent-kind spawn: parent-of-any-role resolution", () => {
  it("resolves the calling pane of any role when no parent is given", async () => {
    const { api, daemon } = server;
    const { services } = daemon;
    const projectId = await registerProject("inv2");

    // The caller is a worker pane (any role must work — docs/agent-kinds.md §3).
    const { session: callerSession } = await services.sessions.spawnWorker(projectId, { issueNumber: 1 });
    const panePid = daemon.tmux.sessions.get(callerSession.tmuxSession)?.panePid;
    expect(panePid).toBeDefined();
    if (panePid === undefined) throw new Error("fake pane has no pid");
    const callerChain: ProcessInfo[] = [
      { pid: 1, ppid: 0, cmdline: ["init"] },
      { pid: panePid, ppid: 1, cmdline: ["sh", "-c", "exec pi"] },
      { pid: panePid + 1, ppid: panePid, cmdline: ["node", ".../pi"] },
      {
        pid: panePid + 2,
        ppid: panePid + 1,
        cmdline: ["node", "/home/me/.pideck/bin/pideck", "spawn", "--kind", "researcher", "--question", "q"],
      },
    ];
    // Swap in a deterministic process table for the discovery probe.
    const original = services.callerProcesses;
    services.callerProcesses = async () => callerChain;
    try {
      const res = await api("POST", `/api/projects/${projectId}/spawn`, {
        kind: "researcher",
        name: "inv",
        question: "who called?",
      });
      expect(res.status).toBe(201);
      expect(sessionSchema.parse(res.json).parentSessionId).toBe(callerSession.id);
    } finally {
      services.callerProcesses = original;
    }
  });

  it("rejects a caller-routed spawn whose caller cannot be resolved (never guesses a parent)", async () => {
    const { api, daemon } = server;
    const { services } = daemon;
    const projectId = await registerProject("inv3");
    const original = services.callerProcesses;
    services.callerProcesses = async () => [];
    try {
      const res = await api("POST", `/api/projects/${projectId}/spawn`, { kind: "researcher", name: "inv" });
      expect(res.status).toBe(409);
      expect((res.json as { error: string }).error).toContain("calling session");
    } finally {
      services.callerProcesses = original;
    }
  });

  it("spawns audits with the project orchestrator as parent and report target", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("aud1");
    // No orchestrator exists yet: the spawn ensures it — the report route
    // always has a live target.
    const res = await api("POST", `/api/projects/${projectId}/spawn`, { kind: "kiss-audit", name: "audit" });
    expect(res.status).toBe(201);
    const session = sessionSchema.parse(res.json);
    expect(session.agentKind).toBe("kiss-audit");
    const orchestrator = daemon.services.sessions
      .listSessions(projectId)
      .find((s) => s.role === "orchestrator");
    expect(orchestrator).toBeDefined();
    expect(session.parentSessionId).toBe(orchestrator!.id);

    // The audit persona reports to {{ORCHESTRATOR_SESSION_ID}}, rendered.
    const persona = personaFile(projectId, session.id);
    expect(persona).toContain(`pideck send --session ${orchestrator!.id}`);
    expect(persona).not.toContain("{{ORCHESTRATOR_SESSION_ID}}");
    // Audits take no question input: the pane bytes carry only the persona
    // launch line (typed by the bootstrap, #290 pattern).
    const bytes = daemon.tmux.sentBytes(session.tmuxSession).toString("utf8");
    expect(bytes).toContain("pi --append-system-prompt");
    expect(bytes).not.toContain("why is build slow?");
  });
});

describe("agent-kind spawn: read-only enforcement + gating", () => {
  it("enforces read-only panes for every kind (write tools excluded from the launch command)", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("ro1");
    const parent = await daemon.services.sessions.ensureOrchestrator(projectId);
    for (const kind of ["researcher", "devex-audit", "kiss-audit"] as const) {
      const res = await api("POST", `/api/projects/${projectId}/spawn`, {
        kind,
        name: "x",
        parentSessionId: parent.id,
        ...(kind === "researcher" ? { question: "q" } : {}),
      });
      expect(res.status).toBe(201);
      const session = sessionSchema.parse(res.json);
      const launchLine = daemon.tmux.sessions.get(session.tmuxSession)?.paneLines[0] ?? "";
      expect(launchLine).toContain("pi --append-system-prompt");
      expect(launchLine).toContain("--exclude-tools edit,write");
      expect(launchLine).toContain(`PD_SESSION_ID=${session.id}`);
    }
  });

  it("queues the researcher's question when pi auth is not ready (issue #56 parity)", async () => {
    // A dedicated daemon with a flipper auth probe (fresh per payload): the
    // question is never typed into an agent that cannot run.
    let authReady = false;
    const runner: PiRunner = async () => ({
      stdout: JSON.stringify({ status: authReady ? "ready" : "unauthenticated" }),
      stderr: "",
    });
    const gated = await startContractServer({ piRunner: runner, piAuthTtlMs: 0 });
    try {
      const { api, daemon } = gated;
      await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/ak/inv4" });
      const parent = await daemon.services.sessions.ensureOrchestrator("ak-inv4");
      const res = await api("POST", "/api/projects/ak-inv4/spawn", {
        kind: "researcher",
        name: "inv",
        question: "held question",
        parentSessionId: parent.id,
      });
      expect(res.status).toBe(201);
      const session = sessionSchema.parse(res.json);
      expect(daemon.tmux.sentBytes(session.tmuxSession).toString("utf8")).not.toContain("held question");
      expect(daemon.services.promptGate.sessionSize).toBe(1);

      // When auth becomes ready, the queued question is delivered.
      authReady = true;
      await daemon.services.promptGate.deliverPending();
      expect(daemon.services.promptGate.sessionSize).toBe(0);
      expect(daemon.tmux.sentBytes(session.tmuxSession).toString("utf8")).toContain("held question");
    } finally {
      await gated.close();
    }
  });
});

describe("agent-kind spawn: caps + route parity", () => {
  it("applies the worker-concurrency cap to worker-like kinds, not researchers", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("cap1", { workerConcurrency: 1 });
    const parent = await daemon.services.sessions.ensureOrchestrator(projectId);
    expect((await api("POST", `/api/projects/${projectId}/spawn`, { kind: "kiss-audit", name: "a1" })).status).toBe(201);
    // Second worker-like spawn past the cap → 409.
    expect((await api("POST", `/api/projects/${projectId}/spawn`, { kind: "devex-audit", name: "a2" })).status).toBe(409);
    // Cheap kinds are exempt (docs/agent-kinds.md §5).
    expect(
      (await api("POST", `/api/projects/${projectId}/spawn`, { kind: "researcher", name: "i1", parentSessionId: parent.id }))
        .status,
    ).toBe(201);
  });

  it("spawns kiss-audit from the menu into exactly ONE session (issue #310 double-fire guard)", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("single1");
    const res = await api("POST", `/api/projects/${projectId}/spawn-agent`, { kind: "kiss-audit", name: "kiss-audit" });
    expect(res.status).toBe(200);
    const projectSessions = daemon.services.sessions.listSessions(projectId);
    // Exactly one kind session (plus the ensured orchestrator) — never a
    // legacy worker alongside it — and the pane carries the persona line.
    expect(projectSessions.filter((s) => s.agentKind !== undefined)).toHaveLength(1);
    expect(daemon.services.sessions.listWorkers({ projectId })).toEqual([]);
    const session = sessionSchema.parse(res.json);
    expect(daemon.tmux.sessions.get(session.tmuxSession)?.paneLines[0] ?? "").toContain("pi --append-system-prompt");
  });

  it("rejects kind bodies that violate the spawn rules (400) and unknown projects (404)", async () => {
    const { api } = server;
    const projectId = await registerProject("bad1");
    // --question is researcher-only; --issue/--prompt never combine with --kind.
    expect(
      (await api("POST", `/api/projects/${projectId}/spawn`, { kind: "devex-audit", name: "x", question: "q" })).status,
    ).toBe(400);
    expect(
      (await api("POST", `/api/projects/${projectId}/spawn`, { kind: "researcher", name: "x", prompt: "do" })).status,
    ).toBe(400);
    expect((await api("POST", "/api/projects/nope/spawn", { kind: "kiss-audit", name: "x" })).status).toBe(404);
  });

  it("spawns through the contract endpoint (spawn-agent) with the Session response", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("ctr1");
    const res = await api("POST", `/api/projects/${projectId}/spawn-agent`, {
      kind: "devex-audit",
      name: "menu-audit",
    });
    expect(res.status).toBe(200);
    const session = sessionSchema.parse(res.json);
    expect(session.agentKind).toBe("devex-audit");
    // The parent is the project orchestrator the audit reports to.
    const orchestrator = daemon.services.sessions.listSessions(projectId).find((s) => s.role === "orchestrator");
    expect(session.parentSessionId).toBe(orchestrator!.id);
  });

  it("keeps plain worker spawns untouched on the same route (no kind in the body)", async () => {
    const { api } = server;
    const projectId = await registerProject("wrk1");
    const res = await api("POST", `/api/projects/${projectId}/spawn`, { issueNumber: 7, name: "w" });
    expect(res.status).toBe(201);
    const worker = workerSchema.parse(res.json);
    expect(worker.issueNumber).toBe(7);
  });

  it("renders the audit persona's PROJECT_PATH to the fresh worktree (worker-like workspaces)", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("aud2");
    const res = await api("POST", `/api/projects/${projectId}/spawn`, { kind: "devex-audit", name: "audit" });
    const session = sessionSchema.parse(res.json);
    expect(session.cwd).toContain(`${daemon.stateDir}/projects/${projectId}/worktrees/`);
    expect(personaFile(projectId, session.id)).toContain(session.cwd!);
  });
});
