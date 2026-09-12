/**
 * End-to-end terminal bridge test against a real tmux server and a real
 * WebSocket. Skipped unless PIDECK_TERMINAL_IT is set:
 *
 *     PIDECK_TERMINAL_IT=1 pnpm vitest run apps/daemon/src/terminal
 *
 * Runs tmux on a private socket so it never touches the user's sessions.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { mountWs, SessionsHub, WS_PATH } from "../api/ws.js";
import { TerminalBridge } from "./bridge.js";
import { Tmux } from "../sessions/tmux.js";

const enabled = process.env.PIDECK_TERMINAL_IT === "1";

describe.skipIf(!enabled)("terminal bridge integration", () => {
  const tmux = new Tmux({ socketName: `pideck-it-${process.pid}` });
  const tmuxSession = `pideck-it-${process.pid}`;
  const sessions = new Map([["s1", { id: "s1", tmuxSession }]]);
  let baseUrl = "";
  let bridge: TerminalBridge | undefined;
  let closeWs: (() => void) | undefined;

  beforeAll(async () => {
    await tmux.run(["new-session", "-d", "-s", tmuxSession]);
    const server: Server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    bridge = new TerminalBridge({
      sessions: { get: (id) => sessions.get(id) },
      tmux,
      log: () => {},
    });
    const hub = new SessionsHub({ snapshot: () => [] });
    closeWs = mountWs(server, bridge, hub);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    baseUrl = `ws://127.0.0.1:${address.port}${WS_PATH}`;
  });

  afterAll(async () => {
    closeWs?.();
    bridge!.dispose();
    // The daemon shutdown path must stop the pipe-pane the stream opened.
    const pipe = await pipeActive().catch(() => "1");
    expect(pipe).toBe("0");
    await tmux.run(["kill-server"]).catch(() => {});
  });

  /** Whether the pane still has a pipe-pane attached. */
  async function pipeActive(): Promise<string> {
    const result = await tmux.run([
      "display-message",
      "-p",
      "-t",
      `${tmuxSession}:`,
      "#{pane_pipe}",
    ]);
    return result.stdout.trim();
  }

  function connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(baseUrl);
      ws.on("open", () => resolve(ws));
      ws.on("error", (err) => reject(err));
    });
  }

  function send(ws: WebSocket, message: unknown): void {
    ws.send(JSON.stringify(message));
  }

  /**
   * Collects `terminal.data` payloads until one contains `needle`; also
   * serves as the attach handshake wait when the pane seed is empty
   * (the attach itself is asserted via the window size below).
   */
  function waitForData(ws: WebSocket, needle: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let received = "";
      const timer = setTimeout(() => {
        ws.off("message", onMessage);
        reject(new Error(`timeout waiting for ${JSON.stringify(needle)}`));
      }, 10_000);
      function onMessage(data: unknown): void {
        const message = JSON.parse(String(data));
        if (message.type !== "terminal.data") return;
        received += message.data;
        if (received.includes(needle)) {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(received);
        }
      }
      ws.on("message", onMessage);
    });
  }

  async function windowWidth(): Promise<number> {
    const result = await tmux.run([
      "display-message",
      "-p",
      "-t",
      `${tmuxSession}:`,
      "#{window_width}",
    ]);
    return Number(result.stdout.trim());
  }

  async function poll(fn: () => Promise<unknown> | unknown): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await fn();
        return;
      } catch {
        if (Date.now() > deadline) throw new Error("poll timeout");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  it("streams a tmux pane over the WebSocket protocol", { timeout: 30_000 }, async () => {
    const first = await connect();
    try {
      send(first, { type: "terminal.attach", sessionId: "s1", cols: 100, rows: 30 });
      await poll(() => expect(windowWidth()).resolves.toBe(100));

      send(first, { type: "terminal.data", sessionId: "s1", data: "echo PIDECK_IT_MARKER\r" });
      await waitForData(first, "PIDECK_IT_MARKER");

      const second = await connect();
      try {
        send(second, { type: "terminal.attach", sessionId: "s1", cols: 100, rows: 30 });
        const replay = await waitForData(second, "PIDECK_IT_MARKER");
        expect(replay).toContain("PIDECK_IT_MARKER");
      } finally {
        second.close();
      }

      send(first, { type: "terminal.resize", sessionId: "s1", cols: 120, rows: 40 });
      await poll(() => expect(windowWidth()).resolves.toBe(120));
    } finally {
      first.close();
    }
  });
});