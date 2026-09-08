/**
 * WebSocket hub (`/api/ws`): kanban / project / worker update fan-out.
 *
 * `broadcast(event)` pushes `KanbanUpdateEvent`s (card moved, project
 * updated, worker spawned / status changed) to every connected client.
 * Producers (spawn endpoint here; pipeline issues #10/#11) call it on state
 * transitions; payloads are validated against `kanbanUpdateEventSchema`
 * before send, so subscribers can rely on the shared contract.
 *
 * Terminal attach/data streaming is a **separate endpoint** (`/ws`) served
 * by `apps/daemon/src/terminal/` (issue #7) — the daemon's entry point wires
 * `attachTerminalWebSocket` onto the same HTTP server. Client `terminal.*`
 * messages arriving here are answered with an error pointing at `/ws`.
 */

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { terminalClientMessageSchema, wsServerEventSchema, type WsServerEvent } from "@pideck/shared";

import { monitorWebSocket } from "../ws-heartbeat.js";

export const WS_PATH = "/api/ws";

export interface WsHubOptions {
  /** Log sink for connect/disconnect lines (default `console.log`). */
  log?: (line: string) => void;
  /** Keepalive ping interval (ms); `0` disables the heartbeat. */
  pingIntervalMs?: number;
}

export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  private readonly connectedAt = new Map<WebSocket, number>();
  private readonly log: (line: string) => void;
  private readonly pingIntervalMs: number;

  constructor(options: WsHubOptions = {}) {
    this.log = options.log ?? ((line) => console.log(line));
    this.pingIntervalMs = options.pingIntervalMs ?? 30_000;
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
      this.clients.add(socket);
      this.connectedAt.set(socket, Date.now());
      // Keepalive (issue #100): terminate half-open sockets so their close
      // cleanup actually runs instead of leaking the client entry.
      monitorWebSocket(socket, { intervalMs: this.pingIntervalMs });
      const remote = req.socket.remoteAddress ?? "unknown";
      this.log(`[ws] connect path=/api/ws remote=${remote} clients=${this.clients.size}`);
      socket.on("message", (raw: unknown) => this.onMessage(socket, raw));
      socket.on("close", () => {
        this.clients.delete(socket);
        const durationMs = Date.now() - (this.connectedAt.get(socket) ?? Date.now());
        this.connectedAt.delete(socket);
        this.log(`[ws] disconnect path=/api/ws durationMs=${durationMs} clients=${this.clients.size}`);
      });
      socket.on("error", () => {
        /* handled by close */
      });
    });
  }

  /**
   * Hooks the hub onto an HTTP server's upgrade event for {@link WS_PATH}.
   * Other upgrade paths (e.g. the terminal bridge's `/ws`) are left for
   * their own handlers; truly unknown paths are destroyed by the server.
   */
  attach(server: HttpServer): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== WS_PATH) return;
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
    });
  }

  /** Currently open client sockets (exposed for tests/monitoring). */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Broadcasts a kanban/project/worker update or notification (issue #111) to every connected client. */
  broadcast(event: WsServerEvent): void {
    const payload = JSON.stringify(wsServerEventSchema.parse(event));
    for (const socket of this.clients) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(payload);
        } catch {
          // A socket that fails mid-send dies through its own close path.
        }
      }
    }
  }

  /** Sends one event to a single socket. */
  send(socket: WebSocket, event: unknown): void {
    socket.send(JSON.stringify(event));
  }

  /** Closes all client connections and stops listening for upgrades. */
  close(): void {
    for (const socket of this.clients) socket.close(1001, "daemon shutting down");
    this.clients.clear();
    this.connectedAt.clear();
    this.wss.close();
  }

  private onMessage(socket: WebSocket, raw: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw)) as unknown;
    } catch {
      this.send(socket, { error: "message is not valid JSON" });
      return;
    }
    const message = terminalClientMessageSchema.safeParse(parsed);
    if (!message.success) {
      this.send(socket, { error: `unsupported message: ${message.error.message}` });
      return;
    }
    // All valid client messages are terminal.* — served on /ws, not here.
    this.send(socket, { error: "terminal attach is served on /ws (see apps/daemon/src/terminal); /api/ws carries kanban updates only" });
  }
}
