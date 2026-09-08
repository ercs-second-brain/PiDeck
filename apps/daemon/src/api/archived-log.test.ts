/**
 * Archived worker session log over HTTP (issue #104): the terminate path
 * captures the pane scrollback and the `GET /api/workers/:workerId/log`
 * contract endpoint serves it back with the worker's final metadata —
 * exercised over real HTTP like `contract.test.ts`.
 */

import { type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { archivedWorkerLogSchema, formatPath } from "@agentskiss/shared";

import { createDaemonServer } from "./server.js";
import { testDaemon, type TestDaemon } from "./testutil.js";

let daemon: TestDaemon;
let server: Server;
let base: string;

beforeAll(async () => {
  daemon = testDaemon();
  const created = createDaemonServer({ services: daemon.services, webDist: null });
  server = created.server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
});

afterAll(async () => {
  daemon.services.hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function api(method: string, path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, { method });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? (JSON.parse(text) as unknown) : undefined };
}

describe("archived worker log endpoint (issue #104)", () => {
  it("serves the captured scrollback plus final metadata after termination", async () => {
    const { services } = daemon;
    services.projects.register({ mode: "clone", repoUrl: "https://github.com/log/rep" });
    const { session, worker } = await services.sessions.spawnWorker("log-rep", { issueNumber: 9, prompt: "Do the work for issue #9" });
    daemon.tmux.sessions.get(session.tmuxSession)?.paneLines.push("work output");

    // Live worker → no archived log yet (404; its pane is still attachable).
    expect((await api("GET", formatPath("getArchivedWorkerLog", { workerId: worker.id }))).status).toBe(404);

    const terminate = await api("POST", formatPath("terminateWorker", { workerId: worker.id }));
    expect(terminate.status).toBe(200);

    const res = await api("GET", formatPath("getArchivedWorkerLog", { workerId: worker.id }));
    expect(res.status).toBe(200);
    const log = archivedWorkerLogSchema.parse(res.json);
    expect(log.workerId).toBe(worker.id);
    expect(log.projectId).toBe(worker.projectId);
    expect(log.issueNumber).toBe(9);
    expect(log.prNumber).toBeNull();
    expect(log.prompt).toBe("Do the work for issue #9");
    expect(log.finalStatus).toBe("archived");
    expect(log.startedAt).toBe(worker.startedAt);
    expect(log.capturedAt).not.toBeNull();
    expect(log.scrollback).toContain("work output");

    // Unknown worker → 404.
    expect((await api("GET", formatPath("getArchivedWorkerLog", { workerId: "worker-ghost" }))).status).toBe(404);
  });

  it("serves an empty scrollback with capturedAt null for pre-capture archives", async () => {
    const { services } = daemon;
    services.projects.register({ mode: "clone", repoUrl: "https://github.com/old/rep" });
    const { worker } = await services.sessions.spawnWorker("old-rep", { issueNumber: 1 });
    // Pane died before terminate → nothing captured, but the endpoint still
    // serves the archived metadata.
    daemon.tmux.sessions.clear();
    await services.sessions.archiveWorker(worker.id);

    const res = await api("GET", formatPath("getArchivedWorkerLog", { workerId: worker.id }));
    expect(res.status).toBe(200);
    const log = archivedWorkerLogSchema.parse(res.json);
    expect(log.capturedAt).toBeNull();
    expect(log.scrollback).toBe("");
    // No prompt recorded at spawn (pre-#120 path) → null in the log metadata.
    expect(log.prompt).toBeNull();
  });
});
