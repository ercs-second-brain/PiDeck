/**
 * Unit tests for the terminal bridge protocol logic, using the fake tmux
 * runner (see `testing/fake-tmux.ts`) and fake sockets — no real tmux, no
 * real WebSocket needed. Real-tmux coverage lives in
 * `terminal.integration.test.ts`.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { terminalServerEventSchema, type TerminalServerEvent } from "@agentskiss/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "../sessions/registry.js";
import { Tmux } from "../sessions/tmux.js";
import {
  CLOSE_SESSION_GONE,
  CLOSE_UNKNOWN_SESSION,
  TerminalBridge,
  type TerminalSocket,
} from "./bridge.js";
import { FakeTmuxRunner } from "./testing/fake-tmux.js";

/** Test double for a browser-side WebSocket. */
class FakeSocket implements TerminalSocket {
  readonly sent: string[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;

  private readonly messageCallbacks: Array<(payload: string) => void> = [];
  private readonly closeCallbacks: Array<() => void> = [];

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code?: number, reason?: string): void {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    for (const cb of this.closeCallbacks) cb();
  }

  onMessage(cb: (payload: string) => void): void {
    this.messageCallbacks.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeCallbacks.push(cb);
  }

  /** Simulates the client sending a message. */
  clientSend(payload: string): void {
    for (const cb of this.messageCallbacks) cb(payload);
  }

  /** Parses everything sent so far as server events. */
  events(): TerminalServerEvent[] {
    return this.sent
      .map((payload) => terminalServerEventSchema.parse(JSON.parse(payload)))
      .filter((event) => event.type.startsWith("terminal."));
  }

  dataEvents(): Extract<TerminalServerEvent, { type: "terminal.data" }>[] {
    return this.events().filter(
      (event): event is Extract<TerminalServerEvent, { type: "terminal.data" }> =>
        event.type === "terminal.data",
    );
  }
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "agentskiss-bridge-"));
  const fake = new FakeTmuxRunner();
  const tmux = new Tmux({ runner: fake.asRunner() });
  const registry = new SessionRegistry(path.join(dir, "sessions.json"));
  const bridge = new TerminalBridge(
    { tmux, registry },
    { activePollMs: 5, idlePollMs: 5, scrollbackLines: 100 },
  );
  return { fake, tmux, registry, bridge };
}

let env: ReturnType<typeof setup>;
let sockets: FakeSocket[] = [];

beforeEach(() => {
  env = setup();
  sockets = [];
});

afterEach(() => {
  for (const socket of sockets) socket.close();
});

function open(bridge: TerminalBridge): FakeSocket {
  const socket = new FakeSocket();
  sockets.push(socket);
  bridge.handleOpen(socket);
  return socket;
}

function send(socket: FakeSocket, message: unknown): void {
  socket.clientSend(JSON.stringify(message));
}

interface SeedOptions {
  projectId?: string;
  role?: "orchestrator" | "worker";
  lines?: string[];
}

async function seedSession(options: SeedOptions = {}) {
  const projectId = options.projectId ?? "proj";
  const role = options.role ?? "orchestrator";
  const tmuxName = `agentskiss-${projectId}-${role}-1`;
  await env.tmux.newSession(tmuxName);
  const session = env.registry.createSession({
    projectId,
    role,
    tmuxSession: tmuxName,
    workerId: null,
  });
  if (options.lines) {
    env.fake.sessions.get(tmuxName)?.paneLines.push(...options.lines);
  }
  return session;
}

describe("TerminalBridge", () => {
  it("closes with 4004 when attaching to an unknown session", async () => {
    const socket = open(env.bridge);
    send(socket, { type: "terminal.attach", sessionId: "nope", cols: 80, rows: 24 });
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
    const socket = open(env.bridge);
    send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.closedWith).not.toBeNull());
    expect(socket.closedWith?.code).toBe(CLOSE_SESSION_GONE);
  });

  it("replays scrollback on attach", async () => {
    const session = await seedSession({ lines: ["history line", "prompt$"] });
    const socket = open(env.bridge);
    send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });

    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));
    const events = socket.events();
    expect(events[0]).toMatchObject({ type: "terminal.attached", sessionId: session.id, resumed: false });
    const replay = events[1]?.type === "terminal.data" ? events[1].data : "";
    expect(replay).toContain("history line");
    expect(replay).toContain("prompt$");
    expect(replay).toMatch(/^\x1b\[2J\x1b\[H/);
  });

  it("streams pane changes to all attached clients", async () => {
    const session = await seedSession({ lines: ["initial"] });
    const a = open(env.bridge);
    const b = open(env.bridge);
    for (const socket of [a, b]) {
      send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
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

  it("forwards input to the pane as hex send-keys", async () => {
    const session = await seedSession();
    const socket = open(env.bridge);
    send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));

    send(socket, { type: "terminal.data", sessionId: session.id, data: "echo hi\r" });
    const pane = env.fake.sessions.get(session.tmuxSession);
    await vi.waitFor(() => expect(pane?.paneLines.at(-1)).toBe("echo hi\r"));
  });

  it("propagates resize to the tmux window", async () => {
    const session = await seedSession();
    const socket = open(env.bridge);
    send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));

    send(socket, { type: "terminal.resize", sessionId: session.id, cols: 120, rows: 30 });
    const pane = env.fake.sessions.get(session.tmuxSession);
    await vi.waitFor(() => {
      expect(pane?.cols).toBe(120);
      expect(pane?.rows).toBe(30);
    });
  });

  it("reconnect replays scrollback and marks the attach as resumed", async () => {
    const session = await seedSession({ lines: ["earlier"] });
    const socket = open(env.bridge);
    send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));

    send(socket, { type: "terminal.reconnect", sessionId: session.id, cols: 80, rows: 24 });
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

  it("stops streaming after detach while the pane keeps running", async () => {
    const session = await seedSession({ lines: ["start"] });
    const socket = open(env.bridge);
    send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));

    send(socket, { type: "terminal.detach", sessionId: session.id });
    const count = socket.sent.length;
    env.fake.sessions.get(session.tmuxSession)?.paneLines.push("after detach");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.sent.length).toBe(count);

    // The streamer stopped (no clients left); a new client can still attach.
    const second = open(env.bridge);
    send(second, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(second.dataEvents().length).toBeGreaterThan(0));
    expect(second.dataEvents()[0]?.data).toContain("after detach");
  });

  it("broadcasts terminal.exited when the tmux session dies", async () => {
    const session = await seedSession({ lines: ["alive"] });
    const socket = open(env.bridge);
    send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));

    env.fake.sessions.delete(session.tmuxSession);
    await vi.waitFor(() => {
      expect(socket.events().at(-1)).toMatchObject({ type: "terminal.exited", exitCode: null });
    });
  });

  it("ignores malformed and unattached messages", async () => {
    const session = await seedSession();
    const socket = open(env.bridge);

    socket.clientSend("not json");
    send(socket, { type: "terminal.data", sessionId: session.id, data: "hi" });
    send(socket, { type: "terminal.attach", sessionId: 42 });
    send(socket, { type: "terminal.resize", sessionId: session.id, cols: 0, rows: -3 });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(socket.sent).toEqual([]);
    expect(socket.closedWith).toBeNull();
    expect(env.fake.sessions.get(session.tmuxSession)?.paneLines).toEqual([]);
  });

  it("keeps streamers per session isolated", async () => {
    const orchestrator = await seedSession({ projectId: "p1", lines: ["orch"] });
    const worker = await seedSession({ projectId: "p1", role: "worker", lines: ["work"] });

    const a = open(env.bridge);
    send(a, { type: "terminal.attach", sessionId: orchestrator.id, cols: 80, rows: 24 });
    const b = open(env.bridge);
    send(b, { type: "terminal.attach", sessionId: worker.id, cols: 80, rows: 24 });
    await vi.waitFor(() => {
      expect(a.dataEvents().length).toBeGreaterThan(0);
      expect(b.dataEvents().length).toBeGreaterThan(0);
    });

    env.fake.sessions.get(orchestrator.tmuxSession)?.paneLines.push("ORCH-OUT");
    await vi.waitFor(() => expect(a.dataEvents().at(-1)?.data).toContain("ORCH-OUT"));
    expect(b.dataEvents().at(-1)?.data).not.toContain("ORCH-OUT");
  });

  it("switching sessions detaches from the previous one", async () => {
    const first = await seedSession({ projectId: "p1" });
    const second = await seedSession({ projectId: "p1", role: "worker" });
    const socket = open(env.bridge);
    send(socket, { type: "terminal.attach", sessionId: first.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));
    expect(env.bridge.clientCount(first.id)).toBe(1);

    send(socket, { type: "terminal.attach", sessionId: second.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(env.bridge.clientCount(second.id)).toBe(1));
    expect(env.bridge.clientCount(first.id)).toBe(0);
  });
});
