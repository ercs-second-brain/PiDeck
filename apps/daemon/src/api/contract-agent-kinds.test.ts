/**
 * Contract test for the agent-kind CRUD endpoints (registry v2, issue #330):
 * GET/POST /api/agent-kinds, PUT/DELETE /api/agent-kinds/:kind — over real
 * HTTP. Covers the shipped-kind guardrails (immutable, undeletable), the
 * update-safe user-kind store, and the live-session deletion guardrail.
 * The spawn-side consumption (spawnableBy, trigger rules) is covered in
 * `agent-kind-spawn.test.ts`; the store itself in
 * `sessions/agent-kinds.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentKindListSchema, agentKindSpecSchema, endpoints, formatPath, upsertAgentKindRequestSchema } from "@pideck/shared";

import { startContractServer, type ContractServer } from "./contract-fixtures.js";

let server: ContractServer;

beforeAll(async () => {
  server = await startContractServer();
});

afterAll(async () => {
  await server?.close();
});

/** A valid user-kind create/update body (persona content is mandatory). */
function kindBody(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    label: name,
    persona: `You are the ${name} agent.`,
    spawnableBy: ["orchestrator"],
    callerWaits: false,
    readOnly: true,
    trigger: "auto",
    taskTemplate: `Write the history of {{PROJECT_NAME}}.`,
    reportTarget: "caller",
    workerLike: false,
    ...overrides,
  };
}

describe("agent-kind CRUD (registry v2, issue #330)", () => {
  it("lists the three shipped kinds as spec-v2 data", async () => {
    const got = await server.api("GET", endpoints.listAgentKinds.path);
    expect(got.status).toBe(200);
    const list = agentKindListSchema.parse(got.json);
    expect(list.kinds.map((kind) => kind.name)).toEqual(["researcher", "devex-audit", "kiss-audit"]);
    expect(list.kinds.every((kind) => kind.readOnly)).toBe(true);
  });

  it("creates, updates, and deletes a user kind (update-safe)", async () => {
    const { api } = server;
    const created = await api("POST", endpoints.createAgentKind.path, kindBody("historian"));
    expect(created.status).toBe(200);
    const kind = agentKindSpecSchema.parse(created.json);
    expect(kind).toMatchObject({ name: "historian", trigger: "auto", reportTarget: "caller" });

    // The create body schema demanded persona content (user kinds have no
    // shipped-default fallback).
    expect(upsertAgentKindRequestSchema.safeParse({ ...kindBody("scribe"), persona: undefined }).success).toBe(false);

    // Listed: shipped first, then the user kind.
    const list = await api("GET", endpoints.listAgentKinds.path);
    expect(agentKindListSchema.parse(list.json).kinds.map((entry) => entry.name)).toEqual([
      "researcher",
      "devex-audit",
      "kiss-audit",
      "historian",
    ]);

    // Update: the body's name must match the URL kind (ids are immutable).
    const updatePath = formatPath("updateAgentKind", { kind: "historian" });
    const updated = await api("PUT", updatePath, kindBody("historian", { label: "chronicle", trigger: "waitForInput", taskTemplate: undefined }));
    expect(updated.status).toBe(200);
    expect(agentKindSpecSchema.parse(updated.json).label).toBe("chronicle");
    expect((await api("PUT", updatePath, kindBody("scribe"))).status).toBe(400);
  });

  it("guards the shipped kinds: collisions 409, updates 409, deletes 409", async () => {
    const { api } = server;
    expect((await api("POST", endpoints.createAgentKind.path, kindBody("researcher"))).status).toBe(409);
    expect(
      (await api("PUT", formatPath("updateAgentKind", { kind: "kiss-audit" }), kindBody("kiss-audit"))).status,
    ).toBe(409);
    expect((await api("DELETE", formatPath("deleteAgentKind", { kind: "researcher" }))).status).toBe(409);
  });

  it("guards user kinds: unknown 404, live sessions 409 (terminate first)", async () => {
    const { api, daemon } = server;
    expect((await api("DELETE", formatPath("deleteAgentKind", { kind: "ghost" }))).status).toBe(404);
    expect((await api("PUT", formatPath("updateAgentKind", { kind: "ghost" }), kindBody("ghost"))).status).toBe(404);

    const kindPath = formatPath("deleteAgentKind", { kind: "scribe" });
    expect((await api("POST", endpoints.createAgentKind.path, kindBody("scribe"))).status).toBe(200);

    // A live session of the kind blocks deletion.
    const project = await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/ak/kinds1" });
    await daemon.services.sessions.spawnAgentKind(project.id, { kind: "scribe", parentSessionId: "sess-caller-1" });
    expect((await api("DELETE", kindPath)).status).toBe(409);

    // After the session is gone, deletion succeeds — edits never touch
    // running panes, and a deleted kind only stops future spawns.
    for (const session of daemon.services.sessions.listSessions(project.id)) {
      daemon.services.registry.deleteSession(session.id);
    }
    expect((await api("DELETE", kindPath)).status).toBe(204);
    expect((await api("DELETE", kindPath)).status).toBe(404);
  });
});
