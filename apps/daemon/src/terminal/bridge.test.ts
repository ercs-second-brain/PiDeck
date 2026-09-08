/**
 * Unit tests for the terminal bridge protocol logic, using the fake tmux
 * runner (see `testing/fake-tmux.ts`) and fake sockets — no real tmux, no
 * real WebSocket needed. Real-tmux coverage lives in
 * `terminal.integration.test.ts`; streaming/coalescing specifics in
 * `bridge-stream.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOSE_SESSION_GONE,
  CLOSE_UNKNOWN_SESSION,
} from "./bridge.js";
import { setupHarness, type BridgeHarness } from "./testing/bridge-harness.js";

let env: BridgeHarness;

beforeEach(() => {
  env = setupHarness();
});

afterEach(() => {
  env.closeAll();
});

describe("TerminalBridge: attach and replay", () => {
  it("closes with 4004 when attaching to an unknown session", async () => {
    const socket = env.open();
    env.send(socket, { type: "terminal.attach", sessionId: "nope", cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.closedWith).not.toBeNull());
    expect(socket.closedWith?.code).toBe(CLOSE_UNKNOWN_SESSION);
  });

  it("closes with 4005 when the tmux session is already gone", async () => {
    const session = env.registry.createSession({
      projectId: "proj",
      role: "orchestrator",
      tmuxSession: "dead",
      workerId: null,
    });
    const socket = env.open();
    env.send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.closedWith).not.toBeNull());
    expect(socket.closedWith?.code).toBe(CLOSE_SESSION_GONE);
  });

  it("replays scrollback on attach", async () => {
    const session = await env.seedSession({ lines: ["history line", "prompt$"] });
    env.fake.sessions.get(session.tmuxSession)!.cursorX = 2;
    env.fake.sessions.get(session.tmuxSession)!.cursorY = 1;
    const socket = env.open();
    env.send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });

    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));
    const events = socket.events();
    expect(events[0]).toMatchObject({ type: "terminal.attached", sessionId: session.id, resumed: false });
    const replay = events[1]?.type === "terminal.data" ? events[1].data : "";
    expect(replay).toContain("history line");
    expect(replay).toContain("prompt$");
    expect(replay).toMatch(/^\x1b\[2J\x1b\[H/);
    // The replay places the client cursor at the pane's true position (#92).
    expect(replay.endsWith("\x1b[?25h\x1b[2;3H")).toBe(true);
  });

  it("reconnect replays scrollback and marks the attach as resumed", async () => {
    const session = await env.seedSession({ lines: ["earlier"] });
    const socket = env.open();
    env.send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));

    env.send(socket, { type: "terminal.reconnect", sessionId: session.id, cols: 80, rows: 24 });
    const lastAttachIndex = await vi.waitFor(() => {
      const events = socket.events();
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event?.type === "terminal.attached") {
          expect(event).toMatchObject({ resumed: true });
          return i;
        }
      }
      return -1;
    });
    expect(lastAttachIndex).toBeGreaterThanOrEqual(0);
    const events = socket.events();
    const afterAttach = events[lastAttachIndex + 1];
    const replay = afterAttach?.type === "terminal.data" ? afterAttach.data : "";
    expect(replay).toContain("earlier");
  });
});

describe("TerminalBridge: streaming lifecycle", () => {
  it("streams pane changes to all attached clients", async () => {
    const session = await env.seedSession({ lines: ["initial"] });
    const a = env.open();
    const b = env.open();
    for (const socket of [a, b]) {
      env.send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    }
    await vi.waitFor(() => {
      expect(a.dataEvents().length).toBeGreaterThan(0);
      expect(b.dataEvents().length).toBeGreaterThan(0);
    });

    env.fake.sessions.get(session.tmuxSession)?.paneLines.push("new output");

    await vi.waitFor(() => {
      expect(a.dataEvents().at(-1)?.data).toContain("new output");
      expect(b.dataEvents().at(-1)?.data).toContain("new output");
    });
  });

  it("applies the attaching client's size to tmux on attach (issue #124)", async () => {
    // A fresh tmux session sits at the detached default (80x24); the first
    // browser attach must resize it to the viewport-fitted size, or the
    // pane renders at a small fixed width no matter the browser size.
    const session = await env.seedSession();
    const pane = env.fake.sessions.get(session.tmuxSession);
    expect(pane?.cols).toBe(80);
    expect(pane?.rows).toBe(24);

    const socket = env.open();
    env.send(socket, { type: "terminal.attach", sessionId: session.id, cols: 154, rows: 51 });
    await vi.waitFor(() => {
      expect(pane?.cols).toBe(154);
      expect(pane?.rows).toBe(51);
    });
  });

  it("re-adopted size wins on a later attach with a different size (issue #124)", async () => {
    const session = await env.seedSession();
    const pane = env.fake.sessions.get(session.tmuxSession);
    const first = env.open();
    env.send(first, { type: "terminal.attach", sessionId: session.id, cols: 154, rows: 51 });
    await vi.waitFor(() => expect(pane?.cols).toBe(154));

    const second = env.open();
    env.send(second, { type: "terminal.attach", sessionId: session.id, cols: 100, rows: 40 });
    await vi.waitFor(() => {
      expect(pane?.cols).toBe(100);
      expect(pane?.rows).toBe(40);
    });
  });

  it("propagates resize to the tmux window", async () => {
    const session = await env.seedSession();
    const socket = env.open();
    env.send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));

    env.send(socket, { type: "terminal.resize", sessionId: session.id, cols: 120, rows: 30 });
    const pane = env.fake.sessions.get(session.tmuxSession);
    await vi.waitFor(() => {
      expect(pane?.cols).toBe(120);
      expect(pane?.rows).toBe(30);
    });
  });

  it("stops streaming after detach while the pane keeps running", async () => {
    const session = await env.seedSession({ lines: ["start"] });
    const socket = env.open();
    env.send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));

    env.send(socket, { type: "terminal.detach", sessionId: session.id });
    const count = socket.sent.length;
    env.fake.sessions.get(session.tmuxSession)?.paneLines.push("after detach");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.sent.length).toBe(count);

    // The streamer stopped (no clients left); a new client can still attach.
    const second = env.open();
    env.send(second, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(second.dataEvents().length).toBeGreaterThan(0));
    expect(second.dataEvents()[0]?.data).toContain("after detach");
  });

  it("broadcasts terminal.exited when the tmux session dies", async () => {
    const session = await env.seedSession({ lines: ["alive"] });
    const socket = env.open();
    env.send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));

    env.fake.sessions.delete(session.tmuxSession);
    await vi.waitFor(() => {
      expect(socket.events().at(-1)).toMatchObject({ type: "terminal.exited", exitCode: null });
    });
  });

  it("ignores malformed and unattached messages", async () => {
    const session = await env.seedSession();
    const socket = env.open();

    socket.clientSend("not json");
    env.send(socket, { type: "terminal.data", sessionId: session.id, data: "hi" });
    env.send(socket, { type: "terminal.attach", sessionId: 42 });
    env.send(socket, { type: "terminal.resize", sessionId: session.id, cols: 0, rows: -3 });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(socket.sent).toEqual([]);
    expect(socket.closedWith).toBeNull();
    expect(env.fake.sessions.get(session.tmuxSession)?.paneLines).toEqual([]);
  });
});

describe("TerminalBridge: client and session bookkeeping", () => {
  it("keeps streamers per session isolated", async () => {
    const orchestrator = await env.seedSession({ projectId: "p1", lines: ["orch"] });
    const worker = await env.seedSession({ projectId: "p1", role: "worker", lines: ["work"] });

    const a = env.open();
    env.send(a, { type: "terminal.attach", sessionId: orchestrator.id, cols: 80, rows: 24 });
    const b = env.open();
    env.send(b, { type: "terminal.attach", sessionId: worker.id, cols: 80, rows: 24 });
    await vi.waitFor(() => {
      expect(a.dataEvents().length).toBeGreaterThan(0);
      expect(b.dataEvents().length).toBeGreaterThan(0);
    });

    env.fake.sessions.get(orchestrator.tmuxSession)?.paneLines.push("ORCH-OUT");
    await vi.waitFor(() => expect(a.dataEvents().at(-1)?.data).toContain("ORCH-OUT"));
    expect(b.dataEvents().at(-1)?.data).not.toContain("ORCH-OUT");
  });

  it("switching sessions detaches from the previous one", async () => {
    const first = await env.seedSession({ projectId: "p1" });
    const second = await env.seedSession({ projectId: "p1", role: "worker" });
    const socket = env.open();
    env.send(socket, { type: "terminal.attach", sessionId: first.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));
    expect(env.bridge.clientCount(first.id)).toBe(1);

    env.send(socket, { type: "terminal.attach", sessionId: second.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(env.bridge.clientCount(second.id)).toBe(1));
    expect(env.bridge.clientCount(first.id)).toBe(0);
  });
});
