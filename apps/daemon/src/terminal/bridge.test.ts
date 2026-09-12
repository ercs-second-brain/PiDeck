/**
 * Terminal bridge unit tests: fake tmux + fake sockets, no real tmux, no
 * real WebSocket. The fake's `paneOutput` appends to the pipe-pane stream
 * file, which drives the same fs.watch → drain → broadcast path the real
 * daemon takes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalDataSchema } from "@pideck/shared";
import {
  CLOSE_SESSION_GONE,
  CLOSE_UNKNOWN_SESSION,
  TerminalBridge,
  type TerminalBridgeOptions,
  type TerminalSocket,
} from "./bridge.js";
import { FakeTmux } from "../sessions/testing/fakeTmux.js";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

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

  clientSend(payload: string): void {
    for (const cb of this.messageCallbacks) cb(payload);
  }

  /** Every `terminal.data` payload received so far, concatenated. */
  received(): string {
    return this.sent
      .map((payload) => TerminalDataSchema.parse(JSON.parse(payload)).data)
      .join("");
  }
}

const SESSION_ID = "s1";
const TMUX_SESSION = "pideck-test";

function setup(options: Partial<Omit<TerminalBridgeOptions, "sessions">> = {}) {
  const tmux = new FakeTmux();
  tmux.createSession(TMUX_SESSION);
  const registry = new Map([[SESSION_ID, { id: SESSION_ID, tmuxSession: TMUX_SESSION }]]);
  const bridge = new TerminalBridge({
    sessions: { get: (id) => registry.get(id) },
    tmux,
    streamPollMs: 10,
    log: () => {},
    ...options,
  });
  const sockets: FakeSocket[] = [];
  const open = (): FakeSocket => {
    const socket = new FakeSocket();
    sockets.push(socket);
    bridge.handleOpen(socket);
    return socket;
  };
  const closeAll = (): void => {
    for (const socket of sockets) socket.close();
  };
  return { tmux, bridge, open, closeAll };
}

describe("terminal bridge", () => {
  it("closes with 4004 for an unknown session id", async () => {
    const { open } = setup();
    const socket = open();
    socket.clientSend(JSON.stringify({ type: "terminal.attach", sessionId: "nope" }));
    await vi.waitFor(() => expect(socket.closedWith?.code).toBe(CLOSE_UNKNOWN_SESSION));
  });

  it("closes with 4005 when the tmux session no longer exists", async () => {
    const { tmux, open } = setup();
    tmux.killSession(TMUX_SESSION);
    const socket = open();
    socket.clientSend(JSON.stringify({ type: "terminal.attach", sessionId: SESSION_ID }));
    await vi.waitFor(() => expect(socket.closedWith?.code).toBe(CLOSE_SESSION_GONE));
  });

  it("replays captured scrollback on the first attach", async () => {
    const { tmux, open } = setup();
    tmux.setCapturePane(TMUX_SESSION, "startup banner\r\n");
    const socket = open();
    socket.clientSend(
      JSON.stringify({ type: "terminal.attach", sessionId: SESSION_ID, cols: 100, rows: 30 }),
    );
    await vi.waitFor(() => expect(socket.received()).toBe("startup banner\r\n"));
  });

  it("replays a fresh capture of the resized screen when the pane size differs", async () => {
    const { tmux, bridge, open } = setup();
    // The pane has been running unattached at 80×24; the buffer holds raw
    // bytes drawn for that geometry.
    tmux.setCapturePane(TMUX_SESSION, "stale 80x24 screen\r\n");
    const first = open();
    attach(first);
    await expectClients(bridge, 1);
    await vi.waitFor(() => expect(first.received()).toBe("stale 80x24 screen\r\n"));
    first.close();

    tmux.paneOutput(TMUX_SESSION, "more 80x24 output\r\n");
    await settle();
    // The client attaches at a size the pane has never rendered for; the
    // canned capture now reflects the screen after the resize + redraw.
    tmux.setCapturePane(TMUX_SESSION, "fresh 200x50 screen\r\n");

    const second = open();
    attach(second, 200, 50);
    await vi.waitFor(() => expect(second.received()).toBe("fresh 200x50 screen\r\n"));

    // The stale bytes were replaced in the replay buffer: a later
    // same-size reconnect replays the resized screen, not the old bytes.
    second.close();
    const third = open();
    attach(third, 200, 50);
    await vi.waitFor(() => expect(third.received()).toBe("fresh 200x50 screen\r\n"));
  });

  it("resizes the tmux window before the replay is captured on attach", async () => {
    const { tmux, open } = setup();
    tmux.setCapturePane(TMUX_SESSION, "startup banner\r\n");
    const socket = open();
    // Hold the resize long enough that a fire-and-forget ordering would
    // replay first; record what the client has received when it completes.
    const seenAtResize: string[] = [];
    const base = tmux.run.bind(tmux);
    tmux.run = (args) => {
      if (args[0] !== "resize-window") return base(args);
      return new Promise((resolve) => {
        setTimeout(() => {
          seenAtResize.push(...socket.sent);
          resolve(base(args));
        }, 50);
      });
    };
    socket.clientSend(
      JSON.stringify({ type: "terminal.attach", sessionId: SESSION_ID, cols: 100, rows: 30 }),
    );
    await vi.waitFor(() => expect(socket.received()).toBe("startup banner\r\n"));
    // The replay was written only after the resize completed.
    expect(seenAtResize).toEqual([]);
  });

  it("streams raw pane output with escape sequences untouched", async () => {
    const { tmux, bridge, open } = setup();
    const socket = open();
    attach(socket);
    await expectClients(bridge, 1);

    const raw = "\x1b[31mred\x1b[0m and \x1b[1mbold\x1b[22m\r\n";
    tmux.paneOutput(TMUX_SESSION, raw);
    await vi.waitFor(() => expect(socket.received()).toContain(raw));
  });

  it("serves several browsers watching the same pane; detaching one keeps it alive", async () => {
    const { tmux, bridge, open, closeAll } = setup();
    const first = open();
    const second = open();
    attach(first);
    attach(second);
    await expectClients(bridge, 2);

    tmux.paneOutput(TMUX_SESSION, "for both\r\n");
    await vi.waitFor(() => {
      expect(first.received()).toContain("for both\r\n");
      expect(second.received()).toContain("for both\r\n");
    });

    first.close();
    tmux.paneOutput(TMUX_SESSION, "still alive\r\n");
    await vi.waitFor(() => expect(second.received()).toContain("still alive\r\n"));
    closeAll();
  });

  it("replays the ring buffer so a reconnecting browser is not blank", async () => {
    const { tmux, bridge, open } = setup();
    const first = open();
    attach(first);
    await expectClients(bridge, 1);
    tmux.paneOutput(TMUX_SESSION, "line-one\r\n");
    await vi.waitFor(() => expect(first.received()).toContain("line-one\r\n"));
    first.close();

    // Output produced while no browser is attached still lands in the buffer.
    tmux.paneOutput(TMUX_SESSION, "line-two\r\n");

    const second = open();
    attach(second);
    await vi.waitFor(() => {
      const replay = second.received();
      expect(replay).toContain("line-one\r\n");
      expect(replay).toContain("line-two\r\n");
    });
  });

  it("forwards input to the pane via hex send-keys", async () => {
    const { tmux, bridge, open } = setup();
    const socket = open();
    attach(socket);
    await expectClients(bridge, 1);
    socket.clientSend(
      JSON.stringify({ type: "terminal.data", sessionId: SESSION_ID, data: "echo hi\r" }),
    );
    await vi.waitFor(() => expect(tmux.inputOf(TMUX_SESSION).toString()).toBe("echo hi\r"));
  });

  it("ignores input from a client that is not attached to the session", async () => {
    const { tmux, open } = setup();
    const socket = open();
    socket.clientSend(
      JSON.stringify({ type: "terminal.data", sessionId: SESSION_ID, data: "nope" }),
    );
    await settle();
    expect(tmux.inputOf(TMUX_SESSION).length).toBe(0);
  });

  it("drops oversized input", async () => {
    const { tmux, bridge, open } = setup({ maxInputBytes: 64 });
    const socket = open();
    attach(socket);
    await expectClients(bridge, 1);
    socket.clientSend(
      JSON.stringify({ type: "terminal.data", sessionId: SESSION_ID, data: "x".repeat(65) }),
    );
    await settle();
    expect(tmux.inputOf(TMUX_SESSION).length).toBe(0);
  });

  it("propagates resize to the tmux window", async () => {
    const { tmux, bridge, open } = setup();
    const socket = open();
    attach(socket, 100, 30);
    await expectClients(bridge, 1);
    await vi.waitFor(() => {
      const pane = tmux.sessions.get(TMUX_SESSION);
      expect(pane?.cols).toBe(100);
      expect(pane?.rows).toBe(30);
    });
    socket.clientSend(
      JSON.stringify({ type: "terminal.resize", sessionId: SESSION_ID, cols: 120, rows: 40 }),
    );
    await vi.waitFor(() => {
      const pane = tmux.sessions.get(TMUX_SESSION);
      expect(pane?.cols).toBe(120);
      expect(pane?.rows).toBe(40);
    });
  });

  it("ignores resize from a client that is not attached", async () => {
    const { tmux, open } = setup();
    const socket = open();
    socket.clientSend(
      JSON.stringify({ type: "terminal.resize", sessionId: SESSION_ID, cols: 120, rows: 40 }),
    );
    await settle();
    expect(tmux.invocations.some((args) => args[0] === "resize-window")).toBe(false);
  });

  it("ignores malformed and unknown messages", async () => {
    const { tmux, open } = setup();
    const socket = open();
    socket.clientSend("not json");
    socket.clientSend(JSON.stringify({ type: "terminal.explode", sessionId: SESSION_ID }));
    socket.clientSend(JSON.stringify({ type: "terminal.attach" }));
    await settle();
    expect(socket.closedWith).toBeNull();
    expect(tmux.invocations.length).toBe(0);
  });

  it("trims the ring buffer to capacity, keeping the newest output", async () => {
    const { tmux, bridge, open } = setup({ ringBytes: 100 });
    const first = open();
    attach(first);
    await expectClients(bridge, 1);
    tmux.paneOutput(TMUX_SESSION, "a".repeat(50));
    tmux.paneOutput(TMUX_SESSION, "b".repeat(50));
    tmux.paneOutput(TMUX_SESSION, "c".repeat(50));
    await vi.waitFor(() => {
      expect(first.received()).toBe("a".repeat(50) + "b".repeat(50) + "c".repeat(50));
    });
    first.close();

    const second = open();
    attach(second);
    await vi.waitFor(() => {
      expect(second.received()).toBe("b".repeat(50) + "c".repeat(50));
    });
  });

  it("keeps one pane stream per session across attach/detach cycles", async () => {
    const { tmux, bridge, open, closeAll } = setup();
    const first = open();
    attach(first);
    await expectClients(bridge, 1);
    first.close();

    const second = open();
    attach(second);
    await expectClients(bridge, 1);
    second.close();

    // The stream stays armed (ring buffer preserved) but tmux keeps the pane.
    expect(tmux.sessions.has(TMUX_SESSION)).toBe(true);
    expect(tmux.pipeActive(TMUX_SESSION)).toBe(true);
    closeAll();
  });

  it("re-pipes a pane that still pipes from a previous daemon run", async () => {
    const { tmux, bridge, open } = setup();
    const stale = tempDir("pideck-stale-");
    tmux.openPipe(TMUX_SESSION, path.join(stale, "stale.stream"));
    expect(tmux.pipeActive(TMUX_SESSION)).toBe(true);

    const socket = open();
    attach(socket);
    await expectClients(bridge, 1);

    // The stream replaced the stale pipe: pane output lands in the new file
    // and reaches the client.
    tmux.paneOutput(TMUX_SESSION, "after restart\r\n");
    await vi.waitFor(() => expect(socket.received()).toContain("after restart\r\n"));
    expect(tmux.pipeStreamPath(TMUX_SESSION)).not.toBe(path.join(stale, "stale.stream"));
  });

  it("disposes every pane stream on close", async () => {
    const { tmux, bridge, open, closeAll } = setup();
    const socket = open();
    attach(socket);
    await expectClients(bridge, 1);
    expect(bridge.streamCount).toBe(1);
    closeAll();
    bridge.dispose();
    await settle();
    expect(bridge.streamCount).toBe(0);
    expect(tmux.pipeActive(TMUX_SESSION)).toBe(false);
  });
});

function attach(socket: FakeSocket, cols = 80, rows = 24): void {
  socket.clientSend(
    JSON.stringify({ type: "terminal.attach", sessionId: SESSION_ID, cols, rows }),
  );
}

/** Waits until the attach handshake completed for `count` clients. */
async function expectClients(
  bridge: TerminalBridge,
  count: number,
): Promise<void> {
  await vi.waitFor(() => expect(bridge.clientCount(SESSION_ID)).toBe(count));
}

/** Lets fire-and-forget async message handling settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}