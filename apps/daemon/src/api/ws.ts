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
import { kanbanUpdateEventSchema, wsClientMessageSchema, type KanbanUpdateEvent } from "@agentskiss/shared";

export const WS_PATH = "/api/ws";

export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (socket: WebSocket, _req: IncomingMessage) => {
      this.clients.add(socket);
      socket.on("message", (raw: unknown) => this.onMessage(socket, raw));
      socket.on("close", () => this.clients.delete(socket));
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

  /** Broadcasts a kanban/project/worker update to every connected client. */
  broadcast(event: KanbanUpdateEvent): void {
    const payload = JSON.stringify(kanbanUpdateEventSchema.parse(event));
    for (const socket of this.clients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
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
    const message = wsClientMessageSchema.safeParse(parsed);
    if (!message.success) {
      this.send(socket, { error: `unsupported message: ${message.error.message}` });
      return;
    }
    // All valid client messages are terminal.* — served on /ws, not here.
    this.send(socket, { error: "terminal attach is served on /ws (see apps/daemon/src/terminal); /api/ws carries kanban updates only" });
  }
}
