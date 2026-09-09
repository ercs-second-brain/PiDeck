/**
 * Contract tests for the session-id terminate route (issue #317):
 * `POST /api/sessions/:sessionId/terminate`. The webapp's agent-kind ✕
 * affordance (#311) sends persona session ids to it — the terminate route
 * family previously resolved only worker ids, so persona spawns could not
 * be exited or removed (404 no route).
 *
 * Issue #357 B9/B10 semantics: persona agents (agent-kind sessions) are
 * **archived**, not deleted — the registry record is kept with
 * `Session.archivedAt`, the pane scrollback is captured (the #104
 * pattern), the captured log is served by `GET /api/sessions/:sessionId/log`,
 * and terminating a parent persona agent archives its live descendant
 * persona agents with it (B10). Worker-backed and worker-less plain
 * sessions keep the #317/#64 semantics.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { archivedAgentSessionLogSchema, sessionSchema, workerSchema } from "@pideck/shared";

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

describe("POST /api/sessions/:sessionId/terminate (issues #317/#357)", () => {
  it("archives a persona agent: 200, record kept with archivedAt, pane dead, parent untouched", async () => {
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
    // The ARCHIVED session is the response (issue #357 B9): the record is
    // kept for history — not deleted — and marked with an archivedAt stamp.
    const archived = sessionSchema.parse(res.json);
    expect(archived.id).toBe(kind.id);
    expect(archived.agentKind).toBe("devex-audit");
    expect(typeof archived.archivedAt).toBe("string");
    // The pane is dead, but the registry record survives the terminate.
    expect(daemon.tmux.sessions.has(kind.tmuxSession)).toBe(false);
    expect(daemon.services.registry.getSession(kind.id)).toBeDefined();
    // Live listings exclude the archived persona agent; the parent is untouched.
    expect(daemon.services.sessions.listSessions().some((session) => session.id === kind.id)).toBe(false);
    expect(daemon.services.sessions.getSession(parent.id)).toBeDefined();
  });
});

describe("archived persona-agent log route (issue #357 B9)", () => {
    it("captures the persona agent's scrollback at terminate time and serves it (GET /:id/log)", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("term-log");
    const parent = await daemon.services.sessions.ensureOrchestrator(projectId);
    const spawned = await api("POST", `/api/projects/${projectId}/spawn-agent`, {
      kind: "devex-audit",
      name: "devex-audit",
      parentSessionId: parent.id,
    });
    const kind = sessionSchema.parse(spawned.json);
    daemon.tmux.notifyOutput(kind.tmuxSession, "audit finding: the flaky test is at src/a.ts:42");

    const term = await api("POST", `/api/sessions/${kind.id}/terminate`);
    expect(term.status).toBe(200);

    const log = await api("GET", `/api/sessions/${kind.id}/log`);
    expect(log.status).toBe(200);
    const parsed = archivedAgentSessionLogSchema.parse(log.json);
    expect(parsed.sessionId).toBe(kind.id);
    expect(parsed.agentKind).toBe("devex-audit");
    expect(typeof parsed.archivedAt).toBe("string");
    expect(parsed.capturedAt).not.toBeNull();
    expect(parsed.scrollback).toContain("the flaky test is at src/a.ts:42");
  });
});

describe("terminate cascades to descendant persona agents (issue #357 B10)", () => {
    it("archives a persona agent's live descendants with it (issue #357 B10)", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("term-cascade");
    const parent = await daemon.services.sessions.ensureOrchestrator(projectId);

    const parentSpawn = await api("POST", `/api/projects/${projectId}/spawn-agent`, {
      kind: "devex-audit",
      name: "parent-audit",
      parentSessionId: parent.id,
    });
    const grand = sessionSchema.parse(parentSpawn.json);
    // A child of the persona agent (the researcher its caller spawned mid-run)…
    const childSpawn = await api("POST", `/api/projects/${projectId}/spawn-agent`, {
      kind: "researcher",
      name: "child-research",
      parentSessionId: grand.id,
      question: "where is the flaky test?",
    });
    expect(childSpawn.status).toBe(200);
    const child = sessionSchema.parse(childSpawn.json);
    // …and a grandchild of that child — the whole lineage must archive.
    const grandChildSpawn = await api("POST", `/api/projects/${projectId}/spawn-agent`, {
      kind: "researcher",
      name: "grand-research",
      parentSessionId: child.id,
      question: "nested question",
    });
    expect(grandChildSpawn.status).toBe(200);
    const grandChild = sessionSchema.parse(grandChildSpawn.json);
    // An unrelated persona agent in the same project must NOT archive.
    const otherSpawn = await api("POST", `/api/projects/${projectId}/spawn-agent`, {
      kind: "kiss-audit",
      name: "other-audit",
      parentSessionId: parent.id,
    });
    const other = sessionSchema.parse(otherSpawn.json);

    const res = await api("POST", `/api/sessions/${grand.id}/terminate`);
    expect(res.status).toBe(200);
    for (const session of [grand, child, grandChild]) {
      const record = daemon.services.registry.getSession(session.id);
      expect(record?.archivedAt).toBeDefined(); // archived (B10 cascade), not deleted
      expect(daemon.tmux.sessions.has(session.tmuxSession)).toBe(false);
      expect(daemon.services.sessions.listSessions().some((live) => live.id === session.id)).toBe(false); // out of live listings
    }
    // The unrelated persona agent stays live.
    expect(daemon.services.registry.getSession(other.id)?.archivedAt).toBeUndefined();
    expect(daemon.tmux.sessions.has(other.tmuxSession)).toBe(true);
    // The parent orchestrator is untouched.
    expect(daemon.services.sessions.getSession(parent.id)).toBeDefined();
  });

  it("serves 404 from the log route for unknown, live, and non-persona sessions", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("term-log-404");
    const orchestrator = await daemon.services.sessions.ensureOrchestrator(projectId);
    const { session: workerSession } = await daemon.services.sessions.spawnWorker(projectId, { issueNumber: 3 });
    // Live persona agent: no archived log yet.
    const spawned = await api("POST", `/api/projects/${projectId}/spawn-agent`, {
      kind: "researcher",
      name: "research",
      parentSessionId: orchestrator.id,
      question: "live question",
    });
    const live = sessionSchema.parse(spawned.json);
    for (const path of [
      "/api/sessions/sess-698a0314/log", // unknown session
      `/api/sessions/${live.id}/log`, // live persona agent
      `/api/sessions/${workerSession.id}/log`, // worker-backed session
      `/api/sessions/${orchestrator.id}/log`, // orchestrator session
    ]) {
      const res = await api("GET", path);
      expect(res.status).toBe(404);
    }
    // The non-archived cases carry the archived-log explanation.
    expect(JSON.stringify(await (await api("GET", `/api/sessions/${live.id}/log`)).json)).toContain("archived log");
  });

  it("rejects relaunching an archived persona agent (409) and excludes it from live listings", async () => {
    const { api, daemon } = server;
    const projectId = await registerProject("term-relaunch");
    const parent = await daemon.services.sessions.ensureOrchestrator(projectId);
    const spawned = await api("POST", `/api/projects/${projectId}/spawn-agent`, {
      kind: "kiss-audit",
      name: "kiss-audit",
      parentSessionId: parent.id,
    });
    const kind = sessionSchema.parse(spawned.json);
    await api("POST", `/api/sessions/${kind.id}/terminate`);

    // Relaunch: archived persona agents are history, not relaunchable panes.
    const relaunch = await api("POST", `/api/sessions/${kind.id}/relaunch`);
    expect(relaunch.status).toBe(409);
    expect(JSON.stringify(relaunch.json)).toContain("archived");
    // Live listings (sidebar + project group) exclude the archived record.
    const all = (await api("GET", "/api/sessions")).json as Array<{ id: string }>;
    expect(all.some((session) => session.id === kind.id)).toBe(false);
    const project = (await api("GET", `/api/projects/${projectId}/sessions`)).json as Array<{ id: string }>;
    expect(project.some((session) => session.id === kind.id)).toBe(false);
    expect(daemon.services.registry.getSession(kind.id)).toBeDefined(); // record kept for history
  });
});

describe("POST /api/sessions/:sessionId/terminate: #317/#64 semantics unchanged", () => {
    it("returns 404 for an unknown session id", async () => {
    const { api } = server;
    const res = await api("POST", "/api/sessions/sess-698a0314/terminate");
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "unknown session: sess-698a0314" });
  });
});

describe("POST /api/sessions/:sessionId/terminate: #317/#64 semantics unchanged", () => {
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
