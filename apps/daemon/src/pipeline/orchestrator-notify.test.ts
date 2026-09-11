/**
 * Unit tests for the deterministic orchestrator notification (issue #490):
 * the message format and the delivery path (`ensureOrchestrator` →
 * `sendKeys`, the `pideck send` mechanism). Failure propagation is part of
 * the contract — the wiring catches and logs, the loop keeps running.
 */

import { describe, expect, it, vi } from "vitest";

import type { Session } from "@pideck/shared";

import { notifyOrchestrator, orchestratorReadyForMergeMessage, type OrchestratorNotifySessions } from "./orchestrator-notify.js";

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

describe("orchestrator-notify (issue #490)", () => {
  it("the ready-for-merge message names the PR, title, and the approved+green state", () => {
    expect(orchestratorReadyForMergeMessage(7, "Resolve #46: fix the loop")).toBe(
      '[pideck] PR #7 "Resolve #46: fix the loop" is CI-green and approved — ready for review and merge.',
    );
  });

  it("delivers into the project's orchestrator pane via ensureOrchestrator + sendKeys", async () => {
    const sessions = fakeSessions();
    await notifyOrchestrator(sessions, "proj-1", orchestratorReadyForMergeMessage(7, "Fix the loop"));
    expect(sessions.ensureOrchestrator).toHaveBeenCalledWith("proj-1");
    expect(sessions.sent).toEqual([{ sessionId: "orch-1", message: '[pideck] PR #7 "Fix the loop" is CI-green and approved — ready for review and merge.' }]);
  });

  it("propagates delivery failures (the wiring logs them; the loop keeps running)", async () => {
    const sessions = fakeSessions({ sendError: new Error("tmux session gone") });
    await expect(notifyOrchestrator(sessions, "proj-1", "hello")).rejects.toThrow("tmux session gone");
    // The ensure step ran; only the send failed.
    expect(sessions.ensureOrchestrator).toHaveBeenCalledTimes(1);
  });
});