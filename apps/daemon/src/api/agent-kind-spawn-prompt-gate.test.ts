/**
 * Prompt-gate v2 over the HTTP spawn path (issue #333): the kind spec's
 * readOnly/trigger/callerWaits flags are honored on the real route — a
 * read-write kind's pane gets the full tool set (no `--exclude-tools`), a
 * callerWaits caller-routed kind's calling pane is told a report is coming,
 * and a waitForInput kind spawned without input sits ready (nothing typed
 * beyond the persona launch line). The full 8-cell permutation matrix over
 * the pure decisions lives in `agent/prompt-gate-v2.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionSchema } from "@pideck/shared";

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
  await daemon.services.projects.register({ mode: "clone", repoUrl: `https://github.com/ak/${id}` });
  return `ak-${id}`;
}

/** A user-defined kind with the config under test (registry v2, issue #330). */
function saveKind(name: string, config: Record<string, unknown> = {}): void {
  server.daemon.services.agentKindStore.save({
    name,
    label: name,
    persona: `You are the ${name} agent.`,
    spawnableBy: ["global", "orchestrator", "worker", "reviewer"],
    callerWaits: false,
    readOnly: true,
    trigger: "waitForInput",
    reportTarget: "caller",
    workerLike: false,
    ...config,
  } as never);
}

describe("agent-kind spawn: prompt-gate v2 on the route (issue #333)", () => {
  it("a read-write kind's pane gets the full tool set (no --exclude-tools)", async () => {
    const { api, daemon } = server;
    saveKind("fixer", { readOnly: false });
    const projectId = await registerProject("pgv1");
    const res = await api("POST", `/api/projects/${projectId}/spawn`, { kind: "fixer", name: "f1" });
    expect(res.status).toBe(201);
    const session = sessionSchema.parse(res.json);
    const launchLine = daemon.tmux.sessions.get(session.tmuxSession)?.paneLines[0] ?? "";
    expect(launchLine).toContain("pi --no-skills --append-system-prompt");
    expect(launchLine).not.toContain("--exclude-tools");
  });

  it("a callerWaits kind's calling pane is told a report is coming (worker caller)", async () => {
    const { api, daemon } = server;
    saveKind("scout", { callerWaits: true });
    const projectId = await registerProject("pgv2");
    const { session: caller } = await daemon.services.sessions.spawnWorker(projectId, { issueNumber: 1 });

    const res = await api("POST", `/api/projects/${projectId}/spawn`, {
      kind: "scout",
      name: "s1",
      parentSessionId: caller.id,
    });
    expect(res.status).toBe(201);
    sessionSchema.parse(res.json);

    // The completion notice reached the CALLER's pane (pi auth ready in the
    // fixture — the gated path delivers immediately).
    const callerBytes = daemon.tmux.sentBytes(caller.tmuxSession).toString("utf8");
    expect(callerBytes).toContain('your scout agent "s1" is working');
    expect(callerBytes).toContain("deliver its report to this session");
  });

  it("a non-callerWaits kind leaves the calling pane untouched", async () => {
    const { api, daemon } = server;
    saveKind("mapper", { callerWaits: false });
    const projectId = await registerProject("pgv3");
    const { session: caller } = await daemon.services.sessions.spawnWorker(projectId, { issueNumber: 2 });

    const res = await api("POST", `/api/projects/${projectId}/spawn`, {
      kind: "mapper",
      name: "m1",
      parentSessionId: caller.id,
    });
    expect(res.status).toBe(201);
    expect(daemon.tmux.sentBytes(caller.tmuxSession).toString("utf8")).not.toContain("is working");
  });

  it("a waitForInput kind spawned without input sits ready (nothing typed beyond the launch)", async () => {
    const { api, daemon } = server;
    saveKind("listener", { trigger: "waitForInput" });
    const projectId = await registerProject("pgv4");
    const res = await api("POST", `/api/projects/${projectId}/spawn`, { kind: "listener", name: "l1" });
    expect(res.status).toBe(201);
    const session = sessionSchema.parse(res.json);
    const bytes = daemon.tmux.sentBytes(session.tmuxSession).toString("utf8");
    // Only the launch line — the pane waits for its caller's input.
    expect(bytes.split("\n").filter((line) => line.trim().length > 0)).toHaveLength(1);
    expect(bytes).toContain("pi --no-skills --append-system-prompt");
  });
});
