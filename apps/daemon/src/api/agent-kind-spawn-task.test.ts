/**
 * Agent-kind auto-task delivery (issue #329): autonomous kinds
 * (`kiss-audit`, `devex-audit`) get their kind-spec taskTemplate — rendered
 * with the persona's project + report-target context — typed into the pane
 * right after the persona boot, through the same gated exactly-once path
 * as the researcher's question (issues #56/#318). The researcher is
 * task-less by config: nothing is typed beyond the launch line.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionSchema } from "@pideck/shared";

import type { PiRunner } from "../agent/pi-auth.js";
import { startContractServer, type ContractServer } from "./contract-fixtures.js";

let server: ContractServer;

beforeAll(async () => {
  server = await startContractServer();
});

afterAll(async () => {
  await server?.close();
});

/** Registers a fresh project (its own clone dir) and returns its id. */
async function registerProject(id: string): Promise<string> {
  const { daemon } = server;
  await daemon.services.projects.register({
    mode: "clone",
    repoUrl: `https://github.com/ak/${id}`,
  });
  return `ak-${id}`;
}

describe("agent-kind spawn: auto-task delivery (issue #329)", () => {
  /** Enter-key `send-keys` invocations targeting one pane. */
  function enterCount(daemon: ContractServer["daemon"], tmuxSession: string): number {
    return daemon.tmux.invocations.filter(
      (inv) =>
        inv.args[0] === "send-keys" &&
        inv.args.includes("Enter") &&
        inv.args.includes("-t") &&
        inv.args[inv.args.indexOf("-t") + 1] === tmuxSession,
    ).length;
  }

  it("delivers the kiss-audit auto-task after the boot — rendered, typed exactly once", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("task1");
    const res = await api("POST", `/api/projects/${projectId}/spawn`, { kind: "kiss-audit", name: "audit" });
    expect(res.status).toBe(201);
    const session = sessionSchema.parse(res.json);
    const orchestrator = daemon.services.sessions
      .listSessions(projectId)
      .find((s) => s.role === "orchestrator");
    expect(orchestrator).toBeDefined();

    // The task is rendered with the persona's context: the project path
    // (the fresh worktree) and the report-target orchestrator id.
    const bytes = daemon.tmux.sentBytes(session.tmuxSession).toString("utf8");
    expect(bytes).toContain("Begin the KISS audit now");
    expect(bytes).toContain(session.cwd!);
    expect(bytes).toContain(`pideck send --session ${orchestrator!.id}`);
    expect(bytes).not.toContain("{{");

    // Exactly once (the #318 path types once and confirms with bare-Enter
    // nudges only): one task payload, and exactly two submit Enters on the
    // pane — the persona launch line + the auto-task. Nothing queued.
    expect(bytes.split("Begin the KISS audit now")).toHaveLength(2);
    expect(enterCount(daemon, session.tmuxSession)).toBe(2);
    expect(daemon.services.promptGate.sessionSize).toBe(0);
  });

  it("delivers the devex-audit auto-task with project + report-target context", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("task2");
    const res = await api("POST", `/api/projects/${projectId}/spawn`, { kind: "devex-audit", name: "audit" });
    expect(res.status).toBe(201);
    const session = sessionSchema.parse(res.json);
    const orchestrator = daemon.services.sessions
      .listSessions(projectId)
      .find((s) => s.role === "orchestrator");
    const bytes = daemon.tmux.sentBytes(session.tmuxSession).toString("utf8");
    expect(bytes).toContain("Begin the devex audit of");
    expect(bytes).toContain(`pideck send --session ${orchestrator!.id}`);
    expect(bytes).not.toContain("{{");
    expect(enterCount(daemon, session.tmuxSession)).toBe(2);
  });

  it("leaves the researcher task-less: nothing typed beyond the persona launch line", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("task3");
    const parent = await daemon.services.sessions.ensureOrchestrator(projectId);
    const res = await api("POST", `/api/projects/${projectId}/spawn`, {
      kind: "researcher",
      name: "inv",
      parentSessionId: parent.id,
    });
    expect(res.status).toBe(201);
    const session = sessionSchema.parse(res.json);

    // No question given and no auto-task in the spec: the pane carries the
    // launch line only — the reactive kind waits for its caller.
    const bytes = daemon.tmux.sentBytes(session.tmuxSession).toString("utf8");
    expect(bytes).toContain("pi --no-skills --append-system-prompt");
    expect(bytes).not.toContain("Begin the");
    expect(enterCount(daemon, session.tmuxSession)).toBe(1);
    expect(daemon.services.promptGate.sessionSize).toBe(0);
  });

  it("queues the auto-task when pi auth is not ready (issue #56 parity)", async () => {
    let authReady = false;
    const runner: PiRunner = async () => ({
      stdout: JSON.stringify({ status: authReady ? "ready" : "unauthenticated" }),
      stderr: "",
    });
    const gated = await startContractServer({ piRunner: runner, piAuthTtlMs: 0 });
    try {
      const { api, daemon } = gated;
      await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/ak/task4" });
      const res = await api("POST", "/api/projects/ak-task4/spawn", { kind: "kiss-audit", name: "audit" });
      expect(res.status).toBe(201);
      const session = sessionSchema.parse(res.json);
      expect(daemon.tmux.sentBytes(session.tmuxSession).toString("utf8")).not.toContain("Begin the KISS audit now");
      expect(daemon.services.promptGate.sessionSize).toBe(1);

      // When auth becomes ready, the queued auto-task is delivered.
      authReady = true;
      await daemon.services.promptGate.deliverPending();
      expect(daemon.services.promptGate.sessionSize).toBe(0);
      expect(daemon.tmux.sentBytes(session.tmuxSession).toString("utf8")).toContain("Begin the KISS audit now");
    } finally {
      await gated.close();
    }
  });
});

