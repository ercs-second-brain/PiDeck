import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { SessionView } from "@pideck/shared";
import { TerminalBridge, type TerminalSocket } from "../terminal/bridge.js";

/** Path of the daemon's single WebSocket endpoint. */
export const WS_PATH = "/ws";

export interface SessionsHubOptions {
  /** The current SessionView snapshot, re-evaluated on every broadcast. */
  snapshot: () => SessionView[];
  /** Coalescing window for bursts of change notifications (ms). */
  debounceMs?: number;
}

/**
 * Broadcasts `sessions.changed` to every client on /ws. A new client gets the
 * current snapshot immediately; afterwards changes are found two ways: an API
 * mutation calls `broadcastSoon` (debounced), and a poll of the snapshot
 * catches changes made outside the API — by the reconciler, for instance.
 */
export class SessionsHub {
  readonly #clients = new Set<WebSocket>();
  readonly #snapshot: () => SessionView[];
  readonly #debounceMs: number;
  #broadcastTimer: NodeJS.Timeout | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #lastJson: string | null = null;

  constructor(options: SessionsHubOptions) {
    this.#snapshot = options.snapshot;
    this.#debounceMs = options.debounceMs ?? 100;
  }

  /** Registers a client and hands it the current snapshot right away. */
  add(ws: WebSocket): void {
    this.#clients.add(ws);
    ws.on("close", () => this.#clients.delete(ws));
    this.#sendTo(ws);
  }

  /** Schedules one debounced broadcast of the current snapshot. */
  broadcastSoon(): void {
    if (this.#broadcastTimer) return;
    this.#broadcastTimer = setTimeout(() => {
      this.#broadcastTimer = undefined;
      this.broadcastNow();
    }, this.#debounceMs);
  }

  broadcastNow(): void {
    const sessions = this.#snapshot();
    for (const ws of this.#clients) this.#sendTo(ws, sessions);
  }

  /** Detects snapshot changes made outside the API and broadcasts them. */
  startPolling(intervalMs: number): void {
    this.#pollTimer = setInterval(() => {
      const json = JSON.stringify(this.#snapshot());
      if (json !== this.#lastJson) {
        this.#lastJson = json;
        this.broadcastSoon();
      }
    }, intervalMs);
    this.#pollTimer.unref();
  }

  close(): void {
    clearTimeout(this.#broadcastTimer);
    clearInterval(this.#pollTimer);
    this.#broadcastTimer = undefined;
    this.#pollTimer = undefined;
    for (const ws of this.#clients) ws.terminate();
    this.#clients.clear();
  }

  #sendTo(ws: WebSocket, sessions?: SessionView[]): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(
      JSON.stringify({ type: "sessions.changed", sessions: sessions ?? this.#snapshot() }),
    );
  }
}

export interface WsMountOptions {
  /** Keepalive ping interval (ms); `0` disables the heartbeat. */
  heartbeatMs?: number;
}

/**
 * Mounts the daemon's single WebSocket at {@link WS_PATH}: every accepted
 * socket is handed to both the terminal bridge (which parses only the
 * terminal.* messages and ignores anything else) and the sessions hub (which
 * only sends). Neither side can corrupt the other.
 */
export function mountWs(
  server: HttpServer,
  bridge: TerminalBridge,
  hub: SessionsHub,
  options: WsMountOptions = {},
): () => void {
  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakMap<WebSocket, boolean>();

  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          for (const ws of wss.clients) {
            if (alive.get(ws) === false) {
              ws.terminate();
              continue;
            }
            alive.set(ws, false);
            ws.ping();
          }
        }, heartbeatMs)
      : undefined;
  heartbeat?.unref();

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname !== WS_PATH) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));
      bridge.handleOpen(adapt(ws));
      hub.add(ws);
    });
  };
  server.on("upgrade", onUpgrade);

  return () => {
    if (heartbeat) clearInterval(heartbeat);
    server.off("upgrade", onUpgrade);
    for (const ws of wss.clients) ws.terminate();
  };
}

function adapt(ws: WebSocket): TerminalSocket {
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