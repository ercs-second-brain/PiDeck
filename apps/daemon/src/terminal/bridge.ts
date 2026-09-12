/**
 * WebSocket ⇄ tmux terminal bridge.
 *
 * Speaks the terminal message family from `@pideck/shared`
 * (`terminal.attach` / `data` / `resize` / `detach` in, `terminal.data`
 * out). Design: no tmux client is ever attached. Output streams raw from
 * `tmux pipe-pane` into a per-session ring buffer and is forwarded
 * byte-for-byte, so escape sequences, colours and cursor positioning reach
 * xterm untouched and many browsers can watch the same pane. Input goes
 * back via chunked hex `send-keys`. Detaching one browser never touches
 * the pane.
 *
 * Replay on attach, by size:
 *
 * - Same size (reconnect after a drop): replay the ring buffer — raw byte
 *   history, byte-for-byte.
 * - Different size: the ring buffer holds bytes the pane drew for its old
 *   geometry, so replaying them paints a stale screen. Instead the window
 *   is resized first, the pane gets a moment to redraw for the new size
 *   (the resize is the SIGWINCH), and the replay is a fresh
 *   `capture-pane -e -p` of the redrawn screen — which also replaces the
 *   ring buffer, so later same-size reconnects replay the resized screen.
 *
 * Sessions are created at 200×50 with `window-size manual` (see Tmux.create),
 * so an unattached pane never renders at tmux's 80×24 default either.
 *
 * The bridge is transport-agnostic: sockets implement {@link TerminalSocket}
 * and the `ws` adapter lives in `api/ws.ts`, keeping the protocol logic
 * unit-testable against fakes.
 */

import { WsClientMessageSchema, type Session } from "@pideck/shared";
import { PaneStream } from "./pane-stream.js";
import { Tmux } from "../sessions/tmux.js";

/** WebSocket close codes (4xxx = application-defined). */
export const CLOSE_UNKNOWN_SESSION = 4004;
export const CLOSE_SESSION_GONE = 4005;

/** Minimal socket surface the bridge needs; implemented by `ws` and test fakes. */
export interface TerminalSocket {
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (payload: string) => void): void;
  onClose(cb: () => void): void;
}

/**
 * Session lookup the bridge needs: id → tmux session name. Structurally a
 * slice of the shared `Session` contract, so the daemon's session registry
 * satisfies it directly.
 */
interface TerminalSessions {
  get(sessionId: string): Pick<Session, "id" | "tmuxSession"> | undefined;
}

export interface TerminalBridgeOptions {
  sessions: TerminalSessions;
  /** Tmux backend; defaults to the real `tmux` binary. */
  tmux?: Tmux;
  /** Ring buffer capacity per session, in bytes (recent scrollback). */
  ringBytes?: number;
  /** Scrollback lines captured once to seed a first-ever attach. */
  scrollbackLines?: number;
  /** Stream-file truncation threshold per session, in bytes. */
  maxStreamFileBytes?: number;
  /** Maximum accepted input size per `terminal.data` message, in bytes. */
  maxInputBytes?: number;
  /** Bytes of input forwarded per `send-keys` invocation. */
  inputChunkBytes?: number;
  /** Poll interval (ms) when fs.watch is unavailable on the stream file. */
  streamPollMs?: number;
  /** Settle time after a size change, letting the pane redraw before the fresh replay capture. */
  redrawSettleMs?: number;
  /** Log sink for connect/attach/diagnostic lines (default `console.log`). */
  log?: (line: string) => void;
}

interface ResolvedOptions {
  sessions: TerminalSessions;
  tmux: Tmux;
  ringBytes: number;
  scrollbackLines: number;
  maxStreamFileBytes: number;
  maxInputBytes: number;
  inputChunkBytes: number;
  streamPollMs: number;
  redrawSettleMs: number;
  log: (line: string) => void;
}

const DEFAULTS = {
  ringBytes: 2 * 1024 * 1024,
  scrollbackLines: 2000,
  maxStreamFileBytes: 8 * 1024 * 1024,
  maxInputBytes: 64 * 1024,
  inputChunkBytes: 4096,
  streamPollMs: 100,
  redrawSettleMs: 300,
};

interface Client {
  readonly socket: TerminalSocket;
  sessionId: string | null;
}

/** The terminal bridge; connect sockets with {@link handleOpen}. */
export class TerminalBridge {
  private readonly options: ResolvedOptions;
  private readonly clients = new Set<Client>();
  /** Live pane streams by session id. */
  private readonly streams = new Map<string, PaneStream>();
  /** In-flight stream startups, keyed by session id (serializes joins). */
  private readonly joining = new Map<string, Promise<PaneStream | null>>();

  constructor(options: TerminalBridgeOptions) {
    this.options = {
      ...DEFAULTS,
      ...options,
      tmux: options.tmux ?? new Tmux(),
      log: options.log ?? ((line) => console.log(line)),
    };
  }

  /** Registers a freshly opened socket and wires its lifecycle callbacks. */
  handleOpen(socket: TerminalSocket): void {
    const client: Client = { socket, sessionId: null };
    this.clients.add(client);
    socket.onMessage((payload) => {
      void this.handleMessage(client, payload);
    });
    socket.onClose(() => {
      this.detach(client);
      this.clients.delete(client);
    });
  }

  /** Number of clients currently attached to a session (diagnostics hook). */
  clientCount(sessionId: string): number {
    return this.streams.get(sessionId)?.clientCount ?? 0;
  }

  /** Number of live pane streams (test/diagnostics hook — leak detection). */
  get streamCount(): number {
    return this.streams.size;
  }

  /** Stops every pane stream (daemon shutdown, tests). */
  dispose(): void {
    for (const stream of this.streams.values()) stream.dispose();
    this.streams.clear();
    this.joining.clear();
  }

  private async handleMessage(client: Client, payload: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return; // non-JSON frame: ignore
    }
    const parsed = WsClientMessageSchema.safeParse(json);
    if (!parsed.success) return; // malformed message: ignore
    const message = parsed.data;
    switch (message.type) {
      case "terminal.attach":
        await this.attach(client, message.sessionId, message.cols, message.rows);
        break;
      case "terminal.data":
        await this.sendInput(client, message.sessionId, message.data);
        break;
      case "terminal.resize":
        await this.resize(client, message.sessionId, message.cols, message.rows);
        break;
      case "terminal.detach":
        this.detach(client);
        break;
    }
  }

  /**
   * Attach (or re-attach after a drop): validates the session, joins (or
   * creates) its pane stream, then replays the ring buffer before the
   * live stream reaches this socket.
   */
  private async attach(
    client: Client,
    sessionId: string,
    cols: number | undefined,
    rows: number | undefined,
  ): Promise<void> {
    const session = this.options.sessions.get(sessionId);
    if (!session) {
      client.socket.close(CLOSE_UNKNOWN_SESSION, "unknown session");
      return;
    }
    const alive = await this.options.tmux.hasSession(session.tmuxSession).catch(() => false);
    if (!alive) {
      client.socket.close(CLOSE_SESSION_GONE, "tmux session no longer exists");
      return;
    }
    if (client.sessionId !== null && client.sessionId !== sessionId) this.detach(client);

    const stream = await this.joinStream(session);
    if (stream === null || stream.isDisposed) {
      client.socket.close(CLOSE_SESSION_GONE, "tmux session no longer exists");
      return;
    }
    // The resize must complete before the replay is captured: the ring
    // buffer holds whatever tmux last rendered, so the window must already
    // be at the client's size or the replayed screen is drawn for a width
    // the pane is not showing (content cut off after reattach).
    let resized = false;
    if (cols !== undefined && rows !== undefined) {
      resized = await this.resizeWindow(session.tmuxSession, cols, rows);
    }

    // Hold broadcasts for this client while the replay is computed: bytes
    // streamed meanwhile stay in the ring buffer and end up in the snapshot
    // taken below. The snapshot itself is read synchronously together with
    // markReady, so nothing can slip between them.
    stream.addClient(client.socket);
    client.sessionId = sessionId;
    // After a size change the raw ring buffer is stale (bytes drawn for
    // the old geometry): let the pane redraw, then replay a fresh capture
    // of the resized screen. Same-size reconnects keep the raw replay.
    const replay = resized
      ? await this.recaptureAfterRedraw(stream)
      : (await stream.ensureSeeded(), stream.replay());
    if (replay.length > 0) {
      client.socket.send(
        JSON.stringify({
          type: "terminal.data",
          sessionId,
          data: replay.toString("utf8"),
        }),
      );
    }
    stream.markReady(client.socket);
    this.options.log(`[terminal] attach session=${sessionId} clients=${stream.clientCount}`);
  }

  /** Joins (or creates) the session's pane stream; `null` if it won't start. */
  private joinStream(session: Pick<Session, "id" | "tmuxSession">): Promise<PaneStream | null> {
    const existing = this.streams.get(session.id);
    if (existing && !existing.isDisposed) return Promise.resolve(existing);
    const inFlight = this.joining.get(session.id);
    if (inFlight) return inFlight;
    const created = this.createStream(session).finally(() => this.joining.delete(session.id));
    this.joining.set(session.id, created);
    return created;
  }

  private async createStream(
    session: Pick<Session, "id" | "tmuxSession">,
  ): Promise<PaneStream | null> {
    const stream = new PaneStream(
      session.id,
      session.tmuxSession,
      this.options.tmux,
      {
        ringBytes: this.options.ringBytes,
        scrollbackLines: this.options.scrollbackLines,
        maxStreamFileBytes: this.options.maxStreamFileBytes,
        pollMs: this.options.streamPollMs,
      },
      this.options.log,
      (disposed) => {
        if (this.streams.get(session.id) === disposed) this.streams.delete(session.id);
      },
    );
    const started = await stream.start();
    if (!started || stream.isDisposed) return null;
    this.streams.set(session.id, stream);
    return stream;
  }

  /** Forwards raw input to the pane in chunked hex `send-keys` calls. */
  private async sendInput(client: Client, sessionId: string, data: string): Promise<void> {
    if (client.sessionId !== sessionId) return;
    const session = this.options.sessions.get(sessionId);
    if (!session) return;
    const bytes = Buffer.from(data, "utf8");
    if (bytes.length === 0 || bytes.length > this.options.maxInputBytes) return;
    for (let offset = 0; offset < bytes.length; offset += this.options.inputChunkBytes) {
      const chunk = bytes.subarray(offset, Math.min(offset + this.options.inputChunkBytes, bytes.length));
      const hex = [...chunk].map((byte) => byte.toString(16).padStart(2, "0"));
      await this.options.tmux
        .run(["send-keys", "-t", session.tmuxSession, "-H", ...hex])
        .catch(() => {});
    }
  }

  /** Propagates a client's terminal size to the session's window. */
  private async resize(client: Client, sessionId: string, cols: number, rows: number): Promise<void> {
    if (client.sessionId !== sessionId) return;
    const session = this.options.sessions.get(sessionId);
    if (!session) return;
    await this.resizeWindow(session.tmuxSession, cols, rows);
  }

  /** Waits out the pane's post-resize redraw, then captures the new screen. */
  private async recaptureAfterRedraw(stream: PaneStream): Promise<Buffer> {
    await new Promise((resolve) => setTimeout(resolve, this.options.redrawSettleMs));
    return stream.recapture();
  }

  /**
   * Propagates a client's terminal size to the session's window. Returns
   * whether the window's size actually changed.
   */
  private async resizeWindow(tmuxSession: string, cols: number, rows: number): Promise<boolean> {
    try {
      const before = await this.options.tmux.run([
        "display-message",
        "-p",
        "-t",
        `${tmuxSession}:`,
        "#{window_width} #{window_height}",
      ]);
      if (before.stdout.trim() === `${cols} ${rows}`) return false;
      await this.options.tmux.run([
        "resize-window",
        "-t",
        `${tmuxSession}:`,
        "-x",
        String(cols),
        "-y",
        String(rows),
      ]);
      return true;
    } catch {
      // The pane may have died between the check and the resize; harmless.
      return false;
    }
  }

  private detach(client: Client): void {
    const sessionId = client.sessionId;
    client.sessionId = null;
    if (sessionId === null) return;
    this.streams.get(sessionId)?.removeClient(client.socket);
  }
}