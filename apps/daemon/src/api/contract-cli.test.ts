/**
 * Contract test for the CLI action routes (agent/README.md, finalized in
 * issue #9): /api/status, /api/pi-auth, worker spawn (+ concurrency cap),
 * and session send.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatPath, piAuthSchema, workerSchema } from "@agentskiss/shared";

import { startContractServer, type ContractServer } from "./contract-fixtures.js";

let server: ContractServer;

beforeAll(async () => {
  server = await startContractServer();
});

afterAll(async () => {
  await server?.close();
});

describe("CLI action routes", () => {
  it("exposes /api/status with the pi auth fields (issue #57)", async () => {
    const res = await server.api("GET", "/api/status");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, name: "agentskiss-daemon", piReady: true });
    expect((res.json as { piProviders: unknown }).piProviders).toBeInstanceOf(Array);
  });

  it("exposes /api/pi-auth with the shared PiAuth shape (issue #57)", async () => {
    const res = await server.api("GET", "/api/pi-auth");
    expect(res.status).toBe(200);
    const parsed = piAuthSchema.parse(res.json);
    expect(parsed.ready).toBe(true);
    expect(parsed.providers.length).toBeGreaterThan(0);
  });

  it("spawns a worker with an issue, freeform via prompt, and validates the cap", async () => {
    const { api, daemon } = server;
    const { services } = daemon;
    services.projects.register({ mode: "clone", repoUrl: "https://github.com/sp/rp", settings: { workerConcurrency: 2 } });

    const spawned = await api("POST", "/api/projects/sp-rp/spawn", { issueNumber: 5, name: "worker-one" });
    expect(spawned.status).toBe(201);
    expect(workerSchema.parse(spawned.json).issueNumber).toBe(5);

    // spawn without issue or prompt → 400
    expect((await api("POST", "/api/projects/sp-rp/spawn", { name: "worker-x" })).status).toBe(400);

    // freeform spawn (prompt only) → issueNumber 0 (documented freeform marker)
    const freeform = await api("POST", "/api/projects/sp-rp/spawn", { name: "freeform", prompt: "Investigate flaky CI" });
    expect(freeform.status).toBe(201);
    expect((freeform.json as { issueNumber: number }).issueNumber).toBe(0);

    // workers endpoint lists both, contract-valid: freeform (0) + issue-backed (5)
    const listed = await api("GET", formatPath("listProjectWorkers", { projectId: "sp-rp" }));
    expect(listed.status).toBe(200);
    const listedIssues = (listed.json as unknown[]).map((w) => workerSchema.parse(w).issueNumber).sort();
    expect(listedIssues).toEqual([0, 5]);

    // concurrency cap: 2 active workers (spawning/running) on a cap of 2
    const third = await api("POST", "/api/projects/sp-rp/spawn", { issueNumber: 8, name: "worker-three" });
    expect(third.status).toBe(409);
    expect((third.json as { error: string }).error).toContain("concurrency cap");
  });

  it("delivers messages to a session's pane and 404s unknown sessions", async () => {
    const { api, daemon } = server;
    const { services } = daemon;
    const session = services.sessions.listSessions()[0];
    expect(session).toBeDefined();
    const res = await api("POST", `/api/sessions/${session?.id}/send`, { message: "hello agent" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true });

    const missing = await api("POST", "/api/sessions/sess-missing/send", { message: "hi" });
    expect(missing.status).toBe(404);
  });
});
