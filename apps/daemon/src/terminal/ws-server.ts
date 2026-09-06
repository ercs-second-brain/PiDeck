/**
 * Adapter wiring {@link TerminalBridge} to a Node HTTP server via the `ws`
 * package. The daemon's real HTTP server (issue #13) can call
 * {@link attachTerminalWebSocket} on its own `http.Server`; the standalone
 * dev harness does the same.
 */

import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { TerminalBridge, type TerminalSocket } from "./bridge.js";

/** Path the terminal WebSocket is served on. */
export const TERMINAL_WS_PATH = "/ws";

/**
 * Attaches a terminal WebSocket endpoint to an HTTP server. Returns the
 * underlying `WebSocketServer` (useful for shutdown handling).
 */
export function attachTerminalWebSocket(
  server: HttpServer,
  bridge: TerminalBridge,
  path: string = TERMINAL_WS_PATH,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname !== path) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      bridge.handleOpen(adaptWebSocket(ws));
    });
  });
  return wss;
}

function adaptWebSocket(ws: WebSocket): TerminalSocket {
  return {
    send: (payload) => {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    },
    close: (code, reason) => ws.close(code, reason),
    onMessage: (cb) => {
      ws.on("message", (data) => cb(data.toString()));
    },
    onClose: (cb) => {
      ws.on("close", () => cb());
    },
  };
}
