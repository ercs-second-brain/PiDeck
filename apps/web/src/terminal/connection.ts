/**
 * Browser-side terminal connection: WebSocket lifecycle for one session,
 * speaking the terminal message family from `@pideck/shared` — the shapes are
 * imported, never restated here.
 *
 * `attach()` opens the socket and sends `terminal.attach` with the pane size;
 * `terminal.data` frames stream into xterm. On an unexpected close it
 * reconnects with jittered exponential backoff and re-attaches — the daemon
 * replays the session's ring buffer, so the pane rebuilds its scrollback
 * (the owner resets the terminal via `onReplay` when the socket opens).
 * `sendInput` and `resize` speak `terminal.data` / `terminal.resize`;
 * `detach()` announces `terminal.detach` and closes cleanly — the tmux pane
 * keeps running server-side.
 */

import { WsServerMessageSchema, type WsClientMessage } from "@pideck/shared";

import { nextBackoffMs } from "./backoff";

export type TerminalStatus = "connecting" | "connected" | "reconnecting";

export interface TerminalCallbacks {
  /** Terminal output chunk (escape sequences included) to write into xterm. */
  onData: (data: string) => void;
  /**
   * The socket just opened and the pane is about to be replayed — the owner
   * must reset its terminal before writing.
   */
  onReplay: () => void;
  /** Connection status changes for the disconnected state. */
  onStatus: (status: TerminalStatus) => void;
}

/** Default WebSocket URL: same origin, daemon-wide /ws path. */
function defaultWsUrl(): string {
  const secure = window.location.protocol === "https:";
  return `${secure ? "wss" : "ws"}://${window.location.host}/ws`;
}

export type WebSocketConstructor = (new (url: string, protocols?: string | string[]) => WebSocket) & {
  readonly OPEN: 1;
};

interface Size {
  cols: number;
  rows: number;
}

export class TerminalConnection {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private size: Size = { cols: 80, rows: 24 };
  private attempt = 0;
  private manual = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly callbacks: TerminalCallbacks,
    private readonly url: string = defaultWsUrl(),
    private readonly WebSocketImpl: WebSocketConstructor = WebSocket,
  ) {}

  /** Attaches to a session, closing any previous connection. */
  attach(sessionId: string, cols: number, rows: number): void {
    if (this.sessionId !== null) {
      this.sendWhenOpen({ type: "terminal.detach", sessionId: this.sessionId });
    }
    this.close();
    this.manual = false;
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
    const sessionId = this.sessionId;
    this.sendWhenOpen({ type: "terminal.detach", sessionId: sessionId ?? "" });
    this.close();
    this.manual = true;
    this.sessionId = null;
  }

  private close(): void {
    this.manual = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private currentSessionId(): string {
    return this.sessionId ?? "";
  }

  private open(): void {
    const sessionId = this.sessionId;
    if (sessionId === null) return;
    this.callbacks.onStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.callbacks.onStatus("connected");
      const size = this.size;
      // A fresh connection replays the session's ring buffer from the
      // beginning, so the owner must reset its terminal first.
      this.callbacks.onReplay();
      const message: WsClientMessage = {
        type: "terminal.attach",
        sessionId,
        cols: size.cols,
        rows: size.rows,
      };
      if (ws.readyState === this.WebSocketImpl.OPEN) ws.send(JSON.stringify(message));
    };
    ws.onmessage = (event) => this.handlePayload(event.data);
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (this.manual || this.sessionId === null) return;
      this.attempt += 1;
      const delay = nextBackoffMs(this.attempt);
      this.callbacks.onStatus("reconnecting");
      this.reconnectTimer = setTimeout(() => this.open(), delay);
    };
  }

  private handlePayload(payload: unknown): void {
    let json: unknown;
    try {
      json = JSON.parse(String(payload));
    } catch {
      return;
    }
    const event = WsServerMessageSchema.safeParse(json);
    if (!event.success) return;
    if (event.data.type === "terminal.data") this.callbacks.onData(event.data.data);
  }

  private sendWhenOpen(message: WsClientMessage): void {
    const ws = this.ws;
    if (ws !== null && ws.readyState === this.WebSocketImpl.OPEN) ws.send(JSON.stringify(message));
  }
}