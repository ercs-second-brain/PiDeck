/**
 * Multi-PR association semantics on the session registry (issue #470):
 * a worker's prNumbers list appends per associated PR, clears remove one,
 * and pre-#470 single-prNumber records migrate on load.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionRegistry } from "./registry.js";

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pideck-registry-multipr-"));
  filePath = path.join(dir, "sessions.json");
});

describe("SessionRegistry: multi-PR association (issue #470)", () => {
  it("appends every associated PR and removes them individually", () => {
    const registry = new SessionRegistry(filePath);
    const session = registry.createSession({ projectId: "a", role: "worker", tmuxSession: "pideck-a-worker-1" });
    const worker = registry.registerWorker({ projectId: "a", sessionId: session.id, issueNumber: 4, status: "running" });
    expect(worker.prNumbers).toEqual([]);

    // Multi-PR: stacked/sibling PRs append; re-recording is idempotent.
    registry.setWorkerPr(worker.id, 7);
    registry.setWorkerPr(worker.id, 7);
    registry.setWorkerPr(worker.id, 9);
    expect(registry.getWorker(worker.id)?.prNumbers).toEqual([7, 9]);

    // Re-association removes exactly the moved PR and keeps the rest.
    registry.clearWorkerPr(worker.id, 7);
    expect(registry.getWorker(worker.id)?.prNumbers).toEqual([9]);
    registry.clearWorkerPr(worker.id, 7); // idempotent
    expect(registry.getWorker(worker.id)?.prNumbers).toEqual([9]);
  });

  it("migrates single-prNumber workers persisted before multi-PR (issue #470)", () => {
    // A registry file written before the prNumber → prNumbers change: the
    // old shape fails the worker schema, so the loader must rewrite it —
    // otherwise the worker is dropped on load.
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        sessions: [],
        workers: [
          {
            id: "worker-legacy",
            projectId: "proj",
            sessionId: "sess-legacy",
            issueNumber: 4,
            prNumber: 7,
            status: "running",
            statusMessage: null,
            startedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const reloaded = new SessionRegistry(filePath);
    const migrated = reloaded.getWorker("worker-legacy");
    expect(migrated?.prNumbers).toEqual([7]);

    // The rewrite persists on the next save: the file carries the list shape.
    reloaded.setWorkerPr("worker-legacy", 9);
    const saved = readFileSync(filePath, "utf8");
    expect(saved).toContain("prNumbers");
    expect(saved).not.toContain('"prNumber"');
  });
});
