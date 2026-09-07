/**
 * Adapter wiring {@link TerminalBridge} to a Node HTTP server via the `ws`
 * package. The daemon's real HTTP server (issue #13) can call
 * {@link attachTerminalWebSocket} on its own `http.Server`; the standalone
 * dev harness does the same.
 */

import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { TerminalBridge, type TerminalSocket } from "./bridge.js";
import { monitorWebSocket } from "../ws-heartbeat.js";

/** Path the terminal WebSocket is served on. */
export const TERMINAL_WS_PATH = "/ws";

/** Options for the terminal WebSocket endpoint. */
export interface TerminalWsOptions {
  /** Keepalive ping interval (ms); `0` disables the heartbeat. */
  pingIntervalMs?: number;
}

/**
 * Attaches a terminal WebSocket endpoint to an HTTP server. Returns the
 * underlying `WebSocketServer` (useful for shutdown handling).
 */
export function attachTerminalWebSocket(
  server: HttpServer,
  bridge: TerminalBridge,
  path: string = TERMINAL_WS_PATH,
  options: TerminalWsOptions = {},
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname !== path) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      // Keepalive (issue #100): pings keep half-open sockets from lingering
      // as zombie clients holding pane streamers open.
      monitorWebSocket(ws, { intervalMs: options.pingIntervalMs ?? 30_000 });
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
