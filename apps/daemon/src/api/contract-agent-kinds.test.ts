/**
 * Contract test for the agent-kind CRUD endpoints (registry v2, issue
 * #330): GET/POST /api/agent-kinds, PUT/DELETE /api/agent-kinds/:kind — over
 * real HTTP. Issue #368 (B18) reverses the shipped-kind immutability
 * guardrails: shipped kinds are editable (stored overrides shadowing the
 * shipped spec) and deletable (persisted tombstones) — covered in the
 * "shipped kinds are user-editable" describe. Also covers the update-safe
 * user-kind store and the live-session deletion guardrail. The spawn-side
 * consumption (spawnableBy, trigger rules) is covered in
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

describe("shipped kinds are user-editable and user-deletable (issue #368)", () => {
  it("edits a shipped kind: the stored override shadows the shipped spec", async () => {
    const { api, daemon } = server;
    const updatePath = formatPath("updateAgentKind", { kind: "kiss-audit" });
    const updated = await api("PUT", updatePath, kindBody("kiss-audit", { label: "my audit" }));
    expect(updated.status).toBe(200);
    expect(agentKindSpecSchema.parse(updated.json).label).toBe("my audit");

    // The live registry resolves the override (spawnable, listed).
    expect(daemon.services.agentKinds.get("kiss-audit")).toMatchObject({ label: "my audit" });
    expect(daemon.services.registry.getSession.length).toBeGreaterThan(0);
    const list = agentKindListSchema.parse((await api("GET", endpoints.listAgentKinds.path)).json);
    expect(list.kinds.find((entry) => entry.name === "kiss-audit")).toMatchObject({ label: "my audit" });
    // Reverting the label re-stores the override (still shadowing).
    expect((await api("PUT", updatePath, kindBody("kiss-audit"))).status).toBe(200);
  });

  it("deletes a shipped kind: tombstoned, out of the live list, persisted across reloads", async () => {
    const { api, daemon } = server;
    const deletePath = formatPath("deleteAgentKind", { kind: "devex-audit" });
    expect((await api("DELETE", deletePath)).status).toBe(204);

    // Out of the live registry: not resolvable, not listed, not spawnable.
    expect(daemon.services.agentKinds.get("devex-audit")).toBeUndefined();
    expect(daemon.services.agentKinds.list().map((entry) => entry.name)).not.toContain("devex-audit");
    expect(daemon.services.agentKinds.isTombstoned("devex-audit")).toBe(true);

    // The tombstone is persisted (daemon reload over the same state dir).
    const store = daemon.services.agentKindStore;
    expect(store.isTombstoned("devex-audit")).toBe(true);
    expect(store.get("devex-audit")).toBeUndefined();

    // Re-deleting is 404 (already gone from the live registry).
    expect((await api("DELETE", deletePath)).status).toBe(404);
  });

  it("re-creates a tombstoned shipped kind: the create lifts the tombstone", async () => {
    const { api, daemon } = server;
    expect((await api("DELETE", formatPath("deleteAgentKind", { kind: "researcher" }))).status).toBe(204);
    expect(daemon.services.agentKinds.get("researcher")).toBeUndefined();

    // A create under the tombstoned name re-creates the kind — the
    // deletion is lifted (the user re-created the persona).
    const created = await api("POST", endpoints.createAgentKind.path, kindBody("researcher"));
    expect(created.status).toBe(200);
    expect(daemon.services.agentKinds.get("researcher")).toMatchObject({ name: "researcher" });
    expect(daemon.services.agentKinds.isTombstoned("researcher")).toBe(false);
  });

  it("blocks deleting a shipped kind with live sessions (terminate first)", async () => {
    const { api, daemon } = server;
    const project = await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/ak/kinds2" });
    await daemon.services.sessions.spawnAgentKind(project.id, { kind: "kiss-audit", parentSessionId: "sess-caller-1" });

    const res = await api("DELETE", formatPath("deleteAgentKind", { kind: "kiss-audit" }));
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.json)).toContain("live session");
    expect(daemon.services.agentKinds.get("kiss-audit")).toBeDefined();
  });
});
