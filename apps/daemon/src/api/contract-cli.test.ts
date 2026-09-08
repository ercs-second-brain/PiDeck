/**
 * Contract test for the CLI action routes (agent/README.md, finalized in
 * issue #9): /api/status, /api/pi-auth, worker spawn (+ concurrency cap),
 * and session send.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { formatPath, piAuthSchema, workerSchema } from "@pideck/shared";

import { startContractServer, type ContractServer } from "./contract-fixtures.js";
import { DaemonClient } from "../cli/client.js";
import { run } from "../cli/main.js";

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
    expect(res.json).toMatchObject({ ok: true, name: "pideck-daemon", piReady: true });
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
    const freeformWorker = workerSchema.parse(freeform.json);
    expect(freeformWorker.issueNumber).toBe(0);
    // The prompt is persisted on the worker record (issue #120).
    expect(freeformWorker.prompt).toBe("Investigate flaky CI");

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

describe("pideck sessions CLI (workspace hierarchy)", () => {
  it("lists sessions daemon-wide without --project, including the global agent", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => logs.push(line));
    try {
      const client = new DaemonClient(server.base);
      // The global agent starts on demand (same idempotent ensure as the
      // daemon boot sweep / webapp sidebar button).
      await client.ensureGlobalAgent();
      let project = server.daemon.services.projects.get("sp-rp");
      if (project === undefined) {
        project = await server.daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/sp/rp" });
      }

      // Without --project: every session, with its projectId column — how
      // the global agent discovers each project's orchestrator session id.
      expect(await run(["sessions"], client)).toBe(0);
      const allRows = logs.filter((line) => line.includes("\t"));
      expect(allRows.some((line) => line.split("\t")[1] === "global")).toBe(true);
      expect(allRows.some((line) => line.split("\t")[1] === project.id)).toBe(true);

      // With --project: only that project's sessions.
      logs.length = 0;
      expect(await run(["sessions", "--project", project.id], client)).toBe(0);
      const scopedRows = logs.filter((line) => line.includes("\t"));
      expect(scopedRows.length).toBeGreaterThan(0);
      expect(scopedRows.every((line) => line.split("\t")[1] === project.id)).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
