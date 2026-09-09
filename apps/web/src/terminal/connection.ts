/**
 * Browser-side terminal connection: WebSocket lifecycle for one tmux
 * session, speaking the terminal message family from `@pideck/shared`.
 *
 * Behavior:
 * - `attach()` opens the socket and sends `terminal.attach`.
 * - On an unexpected close it reconnects with exponential backoff + jitter
 *   and resumes via `terminal.reconnect`; the daemon replays the pane
 *   scrollback, so nothing is lost.
 * - Close code 4004/4005 (unknown / dead session) stops reconnecting and
 *   reports `unavailable`.
 * - `terminal.exited` reports the pane is gone and stops the connection.
 * - `detach()` closes cleanly (user navigated away / picked another
 *   session); tmux keeps the pane alive server-side.
 */

import { type TerminalClientMessage } from "@pideck/shared";

import { nextBackoffMs } from "../lib/backoff";
import { parseWsServerEvent } from "../lib/ws-parse";

export type TerminalStatus =
  | "connecting"
  | "attached"
  | "reconnecting"
  | "exited"
  | "unavailable"
  | "detached";

export interface TerminalCallbacks {
  /** Terminal output chunk (escape sequences included) to write into xterm. */
  onData: (data: string) => void;
  /** Connection status changes for the status bar. */
  onStatus: (status: TerminalStatus, detail?: string) => void;
  /**
   * Called whenever the server is about to replay the pane (attach or
   * reconnect) — the client must reset its terminal before writing.
   */
  onReplay: () => void;
}

/** Default WebSocket URL: same origin, terminal path. */
function defaultTerminalWsUrl(): string {
  const secure = window.location.protocol === "https:";
  return `${secure ? "wss" : "ws"}://${window.location.host}/ws`;
}

interface Size {
  cols: number;
  rows: number;
}

export class TerminalConnection {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private size: Size = { cols: 80, rows: 24 };
  private attempt = 0;
  private everAttached = false;
  private manual = false;
  private reconnectTimer: number | undefined;

  constructor(
    private readonly callbacks: TerminalCallbacks,
    private readonly url: string = defaultTerminalWsUrl(),
  ) {}

  /** Attaches to a session, closing any previous connection. */
  attach(sessionId: string, cols: number, rows: number): void {
    this.detach();
    this.manual = false;
    this.everAttached = false;
    this.attempt = 0;
    this.sessionId = sessionId;
    this.size = { cols, rows };
    this.open();
  }

  /** Forwards keystrokes / paste input to the pane. */
  sendInput(data: string): void {
    this.sendWhenOpen({ type: "terminal.data", sessionId: this.currentSessionId(), data });
  }

  /** Propagates a client resize; adopted on the next (re)connect too. */
  resize(cols: number, rows: number): void {
    this.size = { cols, rows };
    const sessionId = this.sessionId;
    if (sessionId === null) return;
    this.sendWhenOpen({ type: "terminal.resize", sessionId, cols, rows });
  }

  /** Clean local teardown — the tmux pane keeps running. */
  detach(): void {
    this.manual = true;
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const hadSession = this.sessionId !== null;
    this.sessionId = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    if (hadSession) this.callbacks.onStatus("detached");
  }

  private currentSessionId(): string {
    return this.sessionId ?? "";
  }

  private open(): void {
    const sessionId = this.sessionId;
    if (sessionId === null) return;
    this.callbacks.onStatus(this.everAttached ? "reconnecting" : "connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      const size = this.size;
      const message: TerminalClientMessage = {
        type: this.everAttached ? "terminal.reconnect" : "terminal.attach",
        sessionId,
        cols: size.cols,
        rows: size.rows,
      };
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    ws.onmessage = (event) => this.handlePayload(String(event.data));
    ws.onclose = (event) => {
      if (this.ws === ws) this.ws = null;
      if (this.manual || this.sessionId === null) return;
      if (event.code === 4004 || event.code === 4005) {
        this.callbacks.onStatus("unavailable", event.reason || "session no longer exists");
        return;
      }
      this.attempt += 1;
      const delay = nextBackoffMs(this.attempt);
      this.callbacks.onStatus("reconnecting", `retrying in ${Math.round(delay / 100) / 10}s`);
      this.reconnectTimer = window.setTimeout(() => this.open(), delay);
    };
  }

  private handlePayload(payload: string): void {
    const event = parseWsServerEvent(payload);
    if (event === null) return;
    if (!event.type.startsWith("terminal.")) return; // kanban events: other UI
    switch (event.type) {
      case "terminal.attached":
        this.everAttached = true;
        this.attempt = 0;
        this.callbacks.onReplay();
        this.callbacks.onStatus("attached");
        break;
      case "terminal.data":
        this.callbacks.onData(event.data);
        break;
      case "terminal.exited":
        this.callbacks.onStatus("exited", "the tmux session ended");
        this.detach();
        break;
    }
  }

  private sendWhenOpen(message: TerminalClientMessage): void {
    const ws = this.ws;
    if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }
}
