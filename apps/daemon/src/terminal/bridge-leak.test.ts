/**
 * Streamer-lifecycle leak tests (issue #100, phase 2): a pane streamer owns
 * a pipe-pane stream, an fs.watch watcher, and a capture timer — it must be
 * disposed whenever no client ends up attached, and concurrent attaches to
 * the same session must not orphan one of the streamers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeTmuxRunner } from "../sessions/testing/fake-tmux.js";
import type { TmuxRunner } from "../sessions/tmux.js";
import { CLOSE_SESSION_GONE } from "./bridge.js";
import { setupHarness, type BridgeHarness } from "./testing/bridge-harness.js";

describe("TerminalBridge: streamer leaks (issue #100)", () => {
  let failCaptures: boolean;

  beforeEach(() => {
    failCaptures = false;
  });

  afterEach(() => {
    // handled per-test via env
  });

  /** Harness whose `capture-pane` invocations can be made to fail. */
  function setupWithKillSwitch(log?: (line: string) => void): BridgeHarness {
    const fake = new FakeTmuxRunner();
    const base = fake.asRunner();
    const runner: TmuxRunner = (args) =>
      failCaptures && args[0] === "capture-pane"
        ? Promise.reject(new Error("capture-pane failed (test kill switch)"))
        : base(args);
    return setupHarness({ ...(log ? { log } : {}) }, { tmuxRunner: runner });
  }

  it("disposes a freshly created streamer when the attach fails mid-replay", async () => {
    const env = setupWithKillSwitch();
    const session = await env.seedSession({ lines: ["hello"] });
    const socket = env.open();
    // The pane dies (captures fail) between the liveness check and the replay.
    failCaptures = true;
    env.send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await expect.poll(() => socket.closedWith).not.toBeNull();
    expect(socket.closedWith?.code).toBe(CLOSE_SESSION_GONE);
    // Regression (issue #100): the orphaned streamer used to keep its
    // pipe-pane stream, watcher, and capture timer alive forever.
    expect(env.bridge.streamerCount).toBe(0);
    expect(env.fake.pipeActive(session.tmuxSession)).toBe(false);
    env.closeAll();
  });

  it("creates a single streamer when two sockets attach concurrently", async () => {
    const env = setupWithKillSwitch();
    const session = await env.seedSession({ lines: ["shared"] });
    const socketA = env.open();
    const socketB = env.open();
    // Both attaches race before either finishes the async streamer startup.
    env.send(socketA, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    env.send(socketB, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await Promise.all([
      vi.waitFor(() => expect(socketA.dataEvents().length).toBeGreaterThan(0)),
      vi.waitFor(() => expect(socketB.dataEvents().length).toBeGreaterThan(0)),
    ]);
    expect(env.bridge.streamerCount).toBe(1);
    env.closeAll();
    // Both clients detached → the one shared streamer is disposed.
    expect(env.fake.pipeActive(session.tmuxSession)).toBe(false);
  });

  it("logs client and session connect/disconnect lines (issue #100 phase 1)", async () => {
    const lines: string[] = [];
    const env = setupWithKillSwitch((line) => lines.push(line));
    const session = await env.seedSession({ lines: ["logged"] });
    const socket = env.open();
    env.send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => {
      expect(lines.some((l) => l.includes(`[terminal] attach session=${session.id}`))).toBe(true);
    });
    expect(lines.some((l) => l.includes("[terminal] client connected"))).toBe(true);
    socket.close();
    await vi.waitFor(() => {
      expect(lines.some((l) => l.includes(`[terminal] detach session=${session.id}`))).toBe(true);
      expect(lines.some((l) => l.includes("[terminal] client disconnected"))).toBe(true);
    });
    env.closeAll();
  });
});
