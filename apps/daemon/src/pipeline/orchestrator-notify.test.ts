/**
 * Unit tests for the deterministic orchestrator notification (issue #490)
 * and its shell-safe delivery guard (issue #500): the message format and
 * the delivery path (`ensureOrchestrator` → pane guard → `sendKeys`, the
 * `pideck send` mechanism). A bare-shell orchestrator pane is never typed
 * into: the guard recovers it first, and an unrecoverable pane skips the
 * delivery loudly. Failure propagation is part of the contract — the
 * wiring catches and logs, the loop keeps running.
 */

import { describe, expect, it, vi } from "vitest";

import type { Session } from "@pideck/shared";

import { notifyOrchestrator, orchestratorReadyForMergeMessage, type OrchestratorNotifySessions, type OrchestratorPaneGuard } from "./orchestrator-notify.js";

function fakeSessions(options: { sendError?: Error } = {}): OrchestratorNotifySessions & { sent: Array<{ sessionId: string; message: string }> } {
  const sent: Array<{ sessionId: string; message: string }> = [];
  const orchestrator = { id: "orch-1" } as Session;
  return {
    sent,
    ensureOrchestrator: vi.fn(async () => orchestrator),
    sendKeys: vi.fn(async (sessionId: string, keys: string) => {
      if (options.sendError !== undefined) throw options.sendError;
      sent.push({ sessionId, message: keys });
    }),
  };
}

function fakeGuard(result: Session | null): OrchestratorPaneGuard & { calls: Session[] } {
  const calls: Session[] = [];
  return { calls, ensureReadyPane: vi.fn(async (session: Session) => { calls.push(session); return result; }) };
}

describe("orchestrator-notify (issue #490)", () => {
  it("the ready-for-merge message names the PR, title, and the approved+green state", () => {
    expect(orchestratorReadyForMergeMessage(7, "Resolve #46: fix the loop")).toBe(
      '[pideck] PR #7 "Resolve #46: fix the loop" is CI-green and approved — ready for review and merge.',
    );
  });

  it("delivers into the project's orchestrator pane via ensureOrchestrator + guard + sendKeys", async () => {
    const sessions = fakeSessions();
    const guard = fakeGuard({ id: "orch-1" } as Session);
    await notifyOrchestrator(sessions, guard, "proj-1", orchestratorReadyForMergeMessage(7, "Fix the loop"));
    expect(sessions.ensureOrchestrator).toHaveBeenCalledWith("proj-1");
    expect(guard.calls).toEqual([{ id: "orch-1" }]);
    expect(sessions.sent).toEqual([{ sessionId: "orch-1", message: '[pideck] PR #7 "Fix the loop" is CI-green and approved — ready for review and merge.' }]);
  });

  it("propagates delivery failures (the wiring logs them; the loop keeps running)", async () => {
    const sessions = fakeSessions({ sendError: new Error("tmux session gone") });
    const guard = fakeGuard({ id: "orch-1" } as Session);
    await expect(notifyOrchestrator(sessions, guard, "proj-1", "hello")).rejects.toThrow("tmux session gone");
    // The ensure + guard steps ran; only the send failed.
    expect(sessions.ensureOrchestrator).toHaveBeenCalledTimes(1);
    expect(guard.calls).toHaveLength(1);
  });
});

describe("orchestrator-notify shell safety (issue #500)", () => {
  it("skips loudly — with an actionable error and no pane typing — when the guard reports the pane unrecoverable", async () => {
    const sessions = fakeSessions();
    const guard = fakeGuard(null); // bare shell that recovery could not make deliverable
    await expect(notifyOrchestrator(sessions, guard, "proj-1", "hello")).rejects.toThrow(
      /not bootstrapped.*skipping the notification.*orchestrator bootstrap/s,
    );
    // Nothing was typed into the (bare) shell.
    expect(sessions.sent).toEqual([]);
    // The ensure step still ran — the guard was consulted on its session.
    expect(sessions.ensureOrchestrator).toHaveBeenCalledTimes(1);
    expect(guard.calls).toEqual([{ id: "orch-1" }]);
  });
});
