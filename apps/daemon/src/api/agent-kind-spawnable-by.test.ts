/**
 * Agent-kind spawn: spawnableBy enforcement (registry v2, issue #330,
 * docs/agent-kinds.md §5) — a resolvable agent caller must be a role the
 * kind lists; user-driven spawns are unrestricted. Split from
 * agent-kind-spawn.test.ts (KISS line budgets).
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

describe("agent-kind spawn: spawnableBy (registry v2, issue #330)", () => {
  /** Creates a restrictive user kind and returns its spec. */
  function restrictedKind(name: string, spawnableBy: string[]) {
    const { daemon } = server;
    const spec = {
      name,
      label: name,
      persona: `You are the ${name}.`,
      spawnableBy: spawnableBy as never,
      callerWaits: false,
      readOnly: true,
      trigger: "auto",
      taskTemplate: `Do the ${name} pass.`,
      reportTarget: "caller",
      workerLike: false,
    } as const;
    daemon.services.agentKindStore.save(spec);
    return spec;
  }

  it("enforces spawnableBy for an explicit agent parent (403 for a disallowed role)", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("sby1");
    restrictedKind("orchestral", ["orchestrator"]);
    const orchestrator = await daemon.services.sessions.ensureOrchestrator(projectId);
    const workerSpawn = await daemon.services.sessions.spawnWorker(projectId, { issueNumber: 1 });

    // Worker callers are not in the kind's spawnableBy → 403.
    const rejected = await api("POST", `/api/projects/${projectId}/spawn`, {
      kind: "orchestral",
      name: "h1",
      parentSessionId: workerSpawn.session.id,
    });
    expect(rejected.status).toBe(403);
    expect((rejected.json as { error: string }).error).toContain("cannot be spawned by worker sessions");

    // Orchestrator callers are → 201.
    const allowed = await api("POST", `/api/projects/${projectId}/spawn`, {
      kind: "orchestral",
      name: "h2",
      parentSessionId: orchestrator.id,
    });
    expect(allowed.status).toBe(201);
    expect(sessionSchema.parse(allowed.json).parentSessionId).toBe(orchestrator.id);
  });

  it("maps reviewer workers to the reviewer role, orchestrator fallback to orchestrator", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("sby2");
    restrictedKind("review-only", ["reviewer"]);
    const workerSpawn = await daemon.services.sessions.spawnWorker(projectId, { issueNumber: 2 });
    // A worker whose worker record is the reviewer kind counts as a reviewer.
    const reviewer = daemon.services.registry.registerWorker({
      projectId,
      sessionId: workerSpawn.session.id,
      issueNumber: 2,
      kind: "reviewer",
      status: "running",
    });
    // The session links to the reviewer record (the review-spawn pattern).
    daemon.services.registry.setSessionWorker(workerSpawn.session.id, reviewer.id);

    const res = await api("POST", `/api/projects/${projectId}/spawn`, {
      kind: "review-only",
      name: "r1",
      parentSessionId: workerSpawn.session.id,
    });
    expect(res.status).toBe(201);
    expect(sessionSchema.parse(res.json).parentSessionId).toBe(workerSpawn.session.id);
    expect(reviewer.kind).toBe("reviewer");
  });

  it("keeps shipped kinds spawnable by every role (back-compat spawnableBy)", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("sby3");
    const workerSpawn = await daemon.services.sessions.spawnWorker(projectId, { issueNumber: 3 });
    const res = await api("POST", `/api/projects/${projectId}/spawn`, {
      kind: "researcher",
      name: "inv",
      question: "why?",
      parentSessionId: workerSpawn.session.id,
    });
    expect(res.status).toBe(201);
    void daemon;
  });

  it("leaves user-driven spawns (no resolvable caller) unrestricted (issue #328 fallback)", async () => {
    const { api, daemon } = server;
    restrictedKind("menu-only", ["orchestrator"]);
    const projectId = await registerProject("sby4");
    // No parentSessionId and no discoverable caller: spawnableBy does not
    // apply (no agent caller — web menu / CLI), and the project orchestrator
    // is the fallback parent (issue #328, unconditional).
    const res = await api("POST", `/api/projects/${projectId}/spawn`, { kind: "menu-only", name: "m" });
    expect(res.status).toBe(201);
    const session = sessionSchema.parse(res.json);
    const orchestrator = daemon.services.sessions.listSessions(projectId).find((s) => s.role === "orchestrator");
    expect(session.parentSessionId).toBe(orchestrator!.id);
  });
});
