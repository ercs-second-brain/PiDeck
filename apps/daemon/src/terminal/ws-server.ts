/**
 * Adapter wiring the terminal bridge to a Node HTTP server via the `ws`
 * package. The daemon's HTTP server calls {@link attachTerminalBridge};
 * pings keep half-open sockets (phones on flaky networks) from lingering
 * as zombie clients.
 */

import type { Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { TerminalBridge, type TerminalBridgeOptions, type TerminalSocket } from "./bridge.js";

/** Path the daemon's single WebSocket is served on. */
export const TERMINAL_WS_PATH = "/ws";

export interface TerminalWsOptions {
  /** Path the WS endpoint is served on. */
  path?: string;
  /** Keepalive ping interval (ms); `0` disables the heartbeat. */
  pingIntervalMs?: number;
}

export interface TerminalBridgeHandle {
  bridge: TerminalBridge;
  /** Closes every socket, stops the endpoint and disposes pane streams. */
  close(): Promise<void>;
}

/** Attaches the terminal WebSocket endpoint to an HTTP server. */
export function attachTerminalBridge(
  server: HttpServer,
  options: TerminalBridgeOptions & TerminalWsOptions,
): TerminalBridgeHandle {
  const path = options.path ?? TERMINAL_WS_PATH;
  const bridge = new TerminalBridge(options);
  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakMap<WebSocket, boolean>();

  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, options.pingIntervalMs ?? 30_000);
  ping.unref?.();

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname !== path) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));
      bridge.handleOpen(adaptWebSocket(ws));
    });
  };
  server.on("upgrade", onUpgrade);

  return {
    bridge,
    close() {
      clearInterval(ping);
      server.off("upgrade", onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => {
        wss.close(() => {
          bridge.dispose();
          resolve();
        });
      });
    },
  };
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