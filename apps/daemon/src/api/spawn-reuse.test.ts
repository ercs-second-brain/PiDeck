/**
 * The manual spawn route's idle-worker-reuse leg (issue #471): a
 * lane-carrying spawn is handed to an eligible `done` same-lane worker
 * (pane alive, context occupancy at/below the threshold) instead of
 * spawning fresh; the retask replaces the issue/prompt, flips the worker
 * to running, and keeps its lane. The reuse probe is pointed at a crafted
 * pi agent dir via `PI_CODING_AGENT_DIR` (the env pi itself honors).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { spawnWorker } from "./cli-handlers.js";
import { piSessionDir } from "../pipeline/issues/reuse.js";
import { issueRoute, testDaemon } from "./testutil.js";

describe("spawnWorker idle-lane reuse (issue #471)", () => {
  it("re-tasks a done same-lane worker instead of spawning fresh", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pideck-pi-agent-"));
    const prevAgentDir = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    try {
      const daemon = testDaemon({
        api: Object.fromEntries([issueRoute("tw", "rw", 1, "First task"), issueRoute("tw", "rw", 2, "Follow-on task")]),
      });
      await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/tw/rw" });

      // First spawn: a lane-carrying worker. No reusable worker exists yet
      // (nothing done) — it spawns fresh and records the lane.
      const first = await spawnWorker(daemon.services, "tw-rw", { issueNumber: 1, name: "w1", lane: "backend" });
      expect(first.lane).toBe("backend");
      const session = daemon.services.sessions.getSession(first.sessionId);
      if (session?.cwd === undefined) throw new Error("session cwd missing");

      // Craft the worker's pi session telemetry: usage = 100 of 1000 → 10%.
      const sessionDir = piSessionDir(session.cwd, agentDir);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        path.join(sessionDir, "2026-09-10T01-00-00-000Z_s1.jsonl"),
        [
          JSON.stringify({ type: "model_change", provider: "openrouter", modelId: "m/big" }),
          JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 100, cacheRead: 0, cacheWrite: 0 } } }),
        ].join("\n"),
      );
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        path.join(agentDir, "models-store.json"),
        JSON.stringify({ providers: { openrouter: { models: [{ id: "m/big", contextWindow: 1000 }] } } }),
      );

      // Complete the first worker: it is now idle capacity in the lane.
      daemon.services.sessions.updateWorkerStatus(first.id, "done", "done");

      // The follow-on in the SAME lane is re-tasked onto the idle worker —
      // no fresh spawn, new issue/prompt on the record, running again.
      const reused = await spawnWorker(daemon.services, "tw-rw", { issueNumber: 2, name: "w2", lane: "backend" });
      expect(reused.id).toBe(first.id);
      expect(reused.issueNumber).toBe(2);
      expect(reused.status).toBe("running");
      expect(reused.lane).toBe("backend");

      // A different lane spawns fresh (lane mismatch ⇒ no reuse).
      const fresh = await spawnWorker(daemon.services, "tw-rw", { issueNumber: 3, name: "w3", lane: "frontend", prompt: "other lane task" });
      expect(fresh.id).not.toBe(first.id);
    } finally {
      if (prevAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = prevAgentDir;
    }
  });
});

