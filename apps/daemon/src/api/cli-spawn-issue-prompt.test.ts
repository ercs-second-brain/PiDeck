/**
 * Regression tests for issue #378: the orchestrator's canonical worker spawn
 * (`pideck spawn --project X --issue N --name L` — issue-backed, no
 * `--prompt`) left the worker pane
 * EMPTY — the initial-prompt delivery only ran for explicit `--prompt`
 * spawns, so orchestrator-spawned workers booted into pi and sat idle.
 *
 * The fix (issue #266 parity for manual spawns): the spawn handler resolves
 * the initial prompt BEFORE the spawn — explicit `--prompt` wins, else the
 * issue's context is fetched (single-issue REST) and built with the same
 * `buildIssueSpawnPrompt` the auto-spawn pipeline uses — and every prompt
 * then rides the existing gated delivery (pi-auth gate, issue #56; the
 * #318 pane-input readiness wait + submit confirmation, with prompt-gate
 * queueing when the pane is not ready).
 */

import { describe, expect, it } from "vitest";

import { spawnWorker } from "./cli-handlers.js";
import { issueRoute, testDaemon, type FakeGhRoutes } from "./testutil.js";

/** Fake gh routes: one real issue and one pull request (same number space). */
function issueRoutes(): FakeGhRoutes {
  return {
    api: Object.fromEntries([
      issueRoute("o", "r", 5, "Fix the flaky test"),
      issueRoute("o", "r", 9, "Not an issue", true),
    ]),
  };
}

async function daemonWithProject(ghRoutes: FakeGhRoutes = issueRoutes()) {
  const daemon = testDaemon(ghRoutes);
  await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
  return daemon;
}

describe("issue-backed CLI spawns deliver the issue context (issue #378, #266 parity)", () => {
  it("types the built issue-context prompt into the pane and records it on the worker", async () => {
    const daemon = await daemonWithProject();
    const worker = await spawnWorker(daemon.services, "o-r", { issueNumber: 5, name: "w1" });

    // Truthful post-delivery state: the pane got the context, the worker runs.
    expect(worker.status).toBe("running");
    expect(worker.statusMessage).toBe("agent running; initial prompt delivered");
    // The built prompt (the same one the auto-spawn pipeline types) is
    // persisted on the worker record (issue #120) and pane-safe single-line
    // (the worker prompt conventions — embedded newlines would submit early).
    expect(worker.prompt).toContain("worker for issue #5 \"Fix the flaky test\"");
    expect(worker.prompt).toContain("https://github.com/o/r/issues/5");
    expect(worker.prompt).toContain("open a PR");
    expect(worker.prompt).not.toMatch(/\n/);

    const pane = await daemon.services.sessions.capturePane(worker.sessionId);
    expect(pane).toContain("worker for issue #5");
  });

  it("an explicit --prompt still wins over the built issue context", async () => {
    const daemon = await daemonWithProject();
    const worker = await spawnWorker(daemon.services, "o-r", { issueNumber: 5, name: "w2", prompt: "just do X" });
    expect(worker.prompt).toBe("just do X");
    const pane = await daemon.services.sessions.capturePane(worker.sessionId);
    expect(pane).toContain("just do X");
    expect(pane).not.toContain("worker for issue #5");
  });

  it("holds the built prompt on the gate while pi auth is unready, then delivers it", async () => {
    const pi = { ready: false };
    const daemon = testDaemon(issueRoutes(), {
      piRunner: async () => {
        if (!pi.ready) throw new Error("pi: not authenticated");
        return { stdout: '{"status":"ready"}', stderr: "" };
      },
      piAuthTtlMs: 0,
      promptGatePollIntervalMs: 0,
    });
    await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });

    const worker = await spawnWorker(daemon.services, "o-r", { issueNumber: 5, name: "w3" });
    // Issue #56 truthfulness: held at `spawning`, never `running` — with the
    // built context queued (the pane got nothing).
    expect(worker.status).toBe("spawning");
    expect(worker.statusMessage).toContain("waiting for pi auth");
    expect(daemon.services.promptGate.size).toBe(1);
    const before = await daemon.services.sessions.capturePane(worker.sessionId);
    expect(before).not.toContain("worker for issue #5");

    // Auth completes (e.g. `pi /login` on the daemon host): the queued
    // context delivers on the next gate pass.
    pi.ready = true;
    await daemon.services.promptGate.deliverPending();
    const released = daemon.services.sessions.getWorker(worker.id);
    expect(released?.status).toBe("running");
    expect(released?.statusMessage).toBe("agent running; initial prompt delivered");
    const pane = await daemon.services.sessions.capturePane(worker.sessionId);
    expect(pane).toContain("worker for issue #5");
  });

  it("queues the built prompt on the gate when the pane is not ready yet (the launch-delay race)", async () => {
    // The #318 pane-input probe reports not-ready (pi still booting — the
    // user's suspected launch-delay race): the prompt must be queued for a
    // retried delivery, never dropped and never double-typed.
    const paneReady = { ready: false };
    const daemon = testDaemon(issueRoutes(), { paneReady: async () => paneReady.ready });
    await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });

    const worker = await spawnWorker(daemon.services, "o-r", { issueNumber: 5, name: "w4" });
    expect(worker.status).toBe("spawning");
    expect(daemon.services.promptGate.size).toBe(1);
    const before = await daemon.services.sessions.capturePane(worker.sessionId);
    expect(before).not.toContain("worker for issue #5");

    // pi boots: the queued prompt delivers on the next gate pass.
    paneReady.ready = true;
    await daemon.services.promptGate.deliverPending();
    const delivered = daemon.services.sessions.getWorker(worker.id);
    expect(delivered?.status).toBe("running");
    expect(delivered?.statusMessage).toBe("agent running; initial prompt delivered");
    const pane = await daemon.services.sessions.capturePane(worker.sessionId);
    expect(pane).toContain("worker for issue #5");
  });

  it("fails the spawn when the issue cannot be fetched — no idle worker is created", async () => {
    const daemon = await daemonWithProject({}); // no gh routes: the fetch fails
    const sessionsBefore = daemon.services.sessions.listSessions("o-r").length;
    await expect(spawnWorker(daemon.services, "o-r", { issueNumber: 5, name: "w5" })).rejects.toThrow(
      /cannot fetch issue #5 for the worker's initial prompt/,
    );
    // Nothing half-spawned: no worker, no session, no pane.
    expect(daemon.services.sessions.listWorkers({ projectId: "o-r" })).toEqual([]);
    expect(daemon.services.sessions.listSessions("o-r").length).toBe(sessionsBefore);
    expect(daemon.tmux.sessions.size).toBe(0);
  });

  it("fails the spawn when the number is a pull request, not an issue", async () => {
    const daemon = await daemonWithProject();
    await expect(spawnWorker(daemon.services, "o-r", { issueNumber: 9, name: "w6" })).rejects.toThrow(
      /is not an issue/,
    );
    expect(daemon.services.sessions.listWorkers({ projectId: "o-r" })).toEqual([]);
  });
});
