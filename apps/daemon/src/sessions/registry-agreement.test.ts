/**
 * Listing/registry agreement tests (issue #488): the registry loader drops
 * persisted records that no longer match their schema (forward
 * compatibility). When only the worker record drops, its owning session
 * survived with a now-dangling `workerId` — the webapp lists the session
 * and terminates it through that pointer, so the delete became a
 * guaranteed-404 `/api/workers/<id>/terminate` for a row the UI shows.
 * The loader must repair the agreement (clear the pointer, loudly).
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "./registry.js";

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pideck-registry-agreement-"));
  filePath = path.join(dir, "sessions.json");
});

describe("SessionRegistry: listing/registry agreement (issue #488)", () => {
  it("clears a session's workerId when its worker record fails schema validation on load", () => {
    const registry = new SessionRegistry(filePath);
    // A healthy pair ...
    const healthySession = registry.createSession({ projectId: "a", role: "worker", tmuxSession: "pideck-a-worker-1" });
    const healthy = registry.registerWorker({ projectId: "a", sessionId: healthySession.id, issueNumber: 1 });
    registry.setSessionWorker(healthySession.id, healthy.id);
    // ... and a pair whose worker record will not survive the reload.
    const doomedSession = registry.createSession({ projectId: "a", role: "worker", tmuxSession: "pideck-a-worker-2" });
    const doomed = registry.registerWorker({ projectId: "a", sessionId: doomedSession.id, issueNumber: 2 });
    registry.setSessionWorker(doomedSession.id, doomed.id);

    const state = JSON.parse(readFileSync(filePath, "utf8")) as { workers: Array<Record<string, unknown>> };
    const doomedRecord = state.workers.find((worker) => worker["id"] === doomed.id) as Record<string, unknown>;
    doomedRecord["status"] = "not-a-status"; // schema-invalid: the loader drops it
    writeFileSync(filePath, JSON.stringify(state));

    const reloaded = new SessionRegistry(filePath);
    expect(reloaded.getWorker(doomed.id)).toBeUndefined(); // dropped
    expect(reloaded.getWorker(healthy.id)?.status).toBe("spawning"); // intact pair untouched
    // The dangling pointer is cleared: the sidebar row keeps rendering
    // (record-less, the #482 shape) and its delete routes through the #317
    // session-id terminate path instead of a guaranteed-404 worker call.
    expect(reloaded.getSession(doomedSession.id)?.workerId).toBeNull();
    expect(reloaded.getSession(healthySession.id)?.workerId).toBe(healthy.id);
  });

  it("logs dropped records and the dangling-pointer repair loudly", () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((first) => errors.push(String(first)));
    try {
      const registry = new SessionRegistry(filePath);
      const session = registry.createSession({ projectId: "a", role: "worker", tmuxSession: "pideck-a-worker-1" });
      const worker = registry.registerWorker({ projectId: "a", sessionId: session.id, issueNumber: 1 });
      registry.setSessionWorker(session.id, worker.id);

      const state = JSON.parse(readFileSync(filePath, "utf8")) as { workers: Array<Record<string, unknown>> };
      (state.workers.find((entry) => entry["id"] === worker.id) as Record<string, unknown>)["status"] = "bogus";
      writeFileSync(filePath, JSON.stringify(state));

      new SessionRegistry(filePath); // the load that drops + repairs
      expect(errors.some((line) => line.includes("dropped unparsable worker record"))).toBe(true);
      expect(errors.some((line) => line.includes(`references missing worker ${worker.id}`))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
