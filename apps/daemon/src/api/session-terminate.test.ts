/**
 * Contract tests for the session-id terminate route (issue #317):
 * `POST /api/sessions/:sessionId/terminate`. The webapp's agent-kind ✕
 * affordance (#311) sends persona session ids to it — the terminate route
 * family previously resolved only worker ids, so persona spawns could not
 * be exited or removed (404 no route). Covers the agent-kind kill path
 * (registry + pane cleaned up), the 404 for unknown ids, worker-backed
 * parity with the #64 archive handler, and worker-less orchestrator kills.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionSchema, workerSchema } from "@pideck/shared";

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

describe("POST /api/sessions/:sessionId/terminate (issue #317)", () => {
  it("terminates an agent-kind session: 200, session shape, registry entry and pane removed", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("term-kind");
    const parent = await daemon.services.sessions.ensureOrchestrator(projectId);

    const spawned = await api("POST", `/api/projects/${projectId}/spawn-agent`, {
      kind: "devex-audit",
      name: "devex-audit",
      parentSessionId: parent.id,
    });
    expect(spawned.status).toBe(200);
    const kind = sessionSchema.parse(spawned.json);
    expect(daemon.tmux.sessions.has(kind.tmuxSession)).toBe(true);

    const res = await api("POST", `/api/sessions/${kind.id}/terminate`);
    expect(res.status).toBe(200);
    // The removed session is the response, in the session shape the webapp parses.
    const removed = sessionSchema.parse(res.json);
    expect(removed.id).toBe(kind.id);
    expect(removed.agentKind).toBe("devex-audit");
    // The kill path: the registry entry is gone and the tmux pane is dead.
    expect(daemon.services.sessions.getSession(kind.id)).toBeUndefined();
    expect(daemon.tmux.sessions.has(kind.tmuxSession)).toBe(false);
    // The parent orchestrator is untouched.
    expect(daemon.services.sessions.getSession(parent.id)).toBeDefined();
  });

  it("returns 404 for an unknown session id", async () => {
    const { api } = server;
    const res = await api("POST", "/api/sessions/sess-698a0314/terminate");
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "unknown session: sess-698a0314" });
  });

  it("routes worker-backed session ids through the #64 archive path (archived status, records kept)", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("term-worker");
    await daemon.services.sessions.ensureOrchestrator(projectId);
    const { session, worker } = await daemon.services.sessions.spawnWorker(projectId, { issueNumber: 5 });

    const res = await api("POST", `/api/sessions/${session.id}/terminate`);
    expect(res.status).toBe(200);
    // The session record is kept for history; the worker behind it is archived
    // (identical to /api/workers/:workerId/terminate), not stopped-and-dropped.
    expect(daemon.services.sessions.getSession(session.id)).toBeDefined();
    const archived = workerSchema.parse(daemon.services.registry.getWorker(worker.id));
    expect(archived.status).toBe("archived");
  });

  it("kills worker-less orchestrator sessions through the manager kill path", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("term-orch");
    const orchestrator = await daemon.services.sessions.ensureOrchestrator(projectId);

    const res = await api("POST", `/api/sessions/${orchestrator.id}/terminate`);
    expect(res.status).toBe(200);
    expect(sessionSchema.parse(res.json).id).toBe(orchestrator.id);
    expect(daemon.services.sessions.getSession(orchestrator.id)).toBeUndefined();
    expect(daemon.tmux.sessions.has(orchestrator.tmuxSession)).toBe(false);
  });
});
