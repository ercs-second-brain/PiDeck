import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Project, SessionView } from "@pideck/shared";
import { TerminalBridge, type TerminalSocket } from "../terminal/bridge.js";

/** Path of the daemon's single WebSocket endpoint. */
export const WS_PATH = "/ws";

export interface SessionsHubOptions {
  /** The current SessionView snapshot, re-evaluated on every broadcast. */
  snapshot: () => SessionView[];
  /** The current Project list, re-evaluated on every broadcast. */
  projectSnapshot: () => Project[];
  /** Coalescing window for bursts of change notifications (ms). */
  debounceMs?: number;
}

/**
 * Broadcasts `sessions.changed` and `projects.changed` to every client on
 * /ws. A new client gets both current snapshots immediately; afterwards
 * changes are found two ways: an API mutation calls `broadcastSoon`
 * (debounced), and a poll of the snapshots catches changes made outside the
 * API — by the reconciler, for instance.
 */
export class SessionsHub {
  readonly #clients = new Set<WebSocket>();
  readonly #snapshot: () => SessionView[];
  readonly #projectSnapshot: () => Project[];
  readonly #debounceMs: number;
  #broadcastTimer: NodeJS.Timeout | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #lastSessionsJson: string | null = null;
  #lastProjectsJson: string | null = null;

  constructor(options: SessionsHubOptions) {
    this.#snapshot = options.snapshot;
    this.#projectSnapshot = options.projectSnapshot;
    this.#debounceMs = options.debounceMs ?? 100;
  }

  /** Registers a client and hands it both current snapshots right away. */
  add(ws: WebSocket): void {
    this.#clients.add(ws);
    ws.on("close", () => this.#clients.delete(ws));
    this.#sendTo(ws, "sessions.changed", { sessions: this.#snapshot() });
    this.#sendTo(ws, "projects.changed", { projects: this.#projectSnapshot() });
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
    const projects = this.#projectSnapshot();
    this.#lastSessionsJson = JSON.stringify(sessions);
    this.#lastProjectsJson = JSON.stringify(projects);
    for (const ws of this.#clients) {
      this.#sendTo(ws, "sessions.changed", { sessions });
      this.#sendTo(ws, "projects.changed", { projects });
    }
  }

  /** Detects snapshot changes made outside the API and broadcasts them. */
  startPolling(intervalMs: number): void {
    this.#pollTimer = setInterval(() => {
      const sessionsJson = JSON.stringify(this.#snapshot());
      const projectsJson = JSON.stringify(this.#projectSnapshot());
      if (
        sessionsJson !== this.#lastSessionsJson ||
        projectsJson !== this.#lastProjectsJson
      ) {
        this.#lastSessionsJson = sessionsJson;
        this.#lastProjectsJson = projectsJson;
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

  #sendTo(ws: WebSocket, type: "sessions.changed" | "projects.changed", body: object): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type, ...body }));
  }
}

export interface WsMountOptions {
  /** Keepalive ping interval (ms); `0` disables the heartbeat. */
  heartbeatMs?: number;
}

/**
 * Mounts the daemon's single WebSocket at {@link WS_PATH}: every accepted
 * socket is handed to both the terminal bridge (which parses only the
 * terminal.* messages and ignores anything else) and the change hub (which
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