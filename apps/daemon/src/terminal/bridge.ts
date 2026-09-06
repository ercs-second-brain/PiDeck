/**
 * WebSocket ⇄ tmux terminal bridge (issue #7).
 *
 * The bridge speaks the terminal message family from `@agentskiss/shared`
 * (`terminal.attach` / `data` / `resize` / `reconnect` / `detach` and the
 * `terminal.attached` / `data` / `exited` server events).
 *
 * Design:
 * - Every attached client joins the {@link PaneStreamer} of its session.
 *   The streamer polls `capture-pane -p -e` (full scrollback + screen),
 *   diffs the screen against its model (`screen.ts`) and broadcasts escape
 *   updates to all clients — so multiple browser terminals can watch the
 *   same tmux pane concurrently.
 * - Attach/reconnect replays the captured scrollback before streaming, so
 *   a browser that reconnects after a network drop resumes exactly where
 *   the pane is (tmux keeps the pane alive regardless of clients).
 * - Input arrives as UTF-8 text and is forwarded with `send-keys -H`
 *   (one hex byte per argument), which survives control characters and
 *   multibyte UTF-8; large inputs are chunked.
 * - Resize propagates via `resize-window`; the model is resynced with a
 *   full screen repaint.
 *
 * The bridge is transport-agnostic: sockets implement {@link TerminalSocket}
 * and the `ws` adapter lives in `ws-server.ts`, which keeps the protocol
 * logic unit-testable against fake tmux + fake sockets.
 */

import {
  terminalClientMessageSchema,
  type Session,
  type TerminalServerEvent,
} from "@agentskiss/shared";
import type { SessionRegistry } from "../sessions/registry.js";
import type { Tmux } from "../sessions/tmux.js";
import {
  frameUpdate,
  fullRepaint,
  screenRepaint,
  splitCapture,
  withSynchronizedUpdate,
} from "./screen.js";

/** Minimal socket surface the bridge needs; implemented by `ws` and test fakes. */
export interface TerminalSocket {
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (payload: string) => void): void;
  onClose(cb: () => void): void;
}

export interface TerminalBridgeOptions {
  /** Poll interval (ms) while the pane is actively changing. */
  activePollMs?: number;
  /** Poll interval (ms) while the pane looks idle. */
  idlePollMs?: number;
  /** Scrollback lines captured and replayed on attach/reconnect. */
  scrollbackLines?: number;
  /** Maximum accepted input size per `terminal.data` message, in bytes. */
  maxInputBytes?: number;
  /** Bytes of input forwarded per `send-keys` invocation. */
  inputChunkBytes?: number;
}

interface ResolvedOptions {
  activePollMs: number;
  idlePollMs: number;
  scrollbackLines: number;
  maxInputBytes: number;
  inputChunkBytes: number;
}

const DEFAULTS: ResolvedOptions = {
  activePollMs: 50,
  idlePollMs: 250,
  scrollbackLines: 2000,
  maxInputBytes: 65_536,
  inputChunkBytes: 512,
};

/** Polls count as "active" for this long after the last observed change. */
const ACTIVE_WINDOW_MS = 1500;

/** WebSocket close codes (4xxx = application-defined). */
export const CLOSE_UNKNOWN_SESSION = 4004;
export const CLOSE_SESSION_GONE = 4005;

interface ClientState {
  readonly socket: TerminalSocket;
  sessionId: string | null;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Per-session output pump: polls tmux, diffs, broadcasts. Lives while at
 * least one client is attached; tmux itself keeps the pane running without
 * any streamer.
 */
class PaneStreamer {
  readonly clients = new Set<ClientState>();

  /** Visible-screen model rows; `[]` means "resync pending". */
  private model: string[] = [];
  /** The row count the model is split against (last client-reported size). */
  rows = 24;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private lastChangeAt = 0;

  constructor(
    readonly session: Session,
    private readonly tmux: Tmux,
    private readonly options: ResolvedOptions,
    private readonly onDisposed: (streamer: PaneStreamer) => void,
  ) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Current model screen (may be empty while a resync is pending). */
  get screen(): string[] {
    return this.model;
  }

  addClient(client: ClientState): void {
    this.clients.add(client);
    this.poke();
  }

  removeClient(client: ClientState): void {
    this.clients.delete(client);
    if (this.clients.size === 0) this.dispose();
  }

  /**
   * Client-reported size changed: resize the tmux window and invalidate the
   * model so the next poll repaints every client's screen.
   */
  async resize(cols: number, rows: number): Promise<void> {
    this.rows = rows;
    try {
      await this.tmux.resize(this.session.tmuxSession, cols, rows);
    } catch {
      // Pane may have died between the check and the resize; the poller
      // will notice and report `terminal.exited`.
    }
    this.model = [];
    this.poke();
  }

  /** Forces a full screen repaint on the next poll. */
  invalidate(): void {
    this.model = [];
    this.poke();
  }

  /** Requests a poll as soon as possible (e.g. after user input). */
  poke(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), 0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.onDisposed(this);
  }

  private schedule(delayMs: number): void {
    if (this.disposed) return;
    this.timer = setTimeout(() => void this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    this.timer = undefined;
    if (this.disposed) return;

    let raw: string;
    try {
      const result = await this.tmux.run([
        "capture-pane",
        "-p",
        "-e",
        "-t",
        this.session.tmuxSession,
        "-S",
        `-${this.options.scrollbackLines}`,
      ]);
      raw = result.stdout;
    } catch {
      const alive = await this.tmux.hasSession(this.session.tmuxSession).catch(() => false);
      if (!alive) {
        this.exited();
        return;
      }
      this.schedule(this.options.idlePollMs);
      return;
    }

    const { screen } = splitCapture(raw, this.rows);
    if (this.model.length !== screen.length) {
      // First frame after (re)start or a resize: full screen repaint.
      this.model = screen;
      this.broadcast(screenRepaint(screen));
      this.lastChangeAt = Date.now();
    } else {
      const update = frameUpdate(this.model, screen);
      if (update.length > 0) {
        this.model = screen;
        this.broadcast(update);
        this.lastChangeAt = Date.now();
      }
    }

    const active = Date.now() - this.lastChangeAt < ACTIVE_WINDOW_MS;
    this.schedule(active ? this.options.activePollMs : this.options.idlePollMs);
  }

  private exited(): void {
    this.dispose();
    const event: TerminalServerEvent = {
      type: "terminal.exited",
      at: now(),
      sessionId: this.session.id,
      exitCode: null,
    };
    const payload = JSON.stringify(event);
    for (const client of this.clients) client.socket.send(payload);
  }

  private broadcast(update: string): void {
    const event: TerminalServerEvent = {
      type: "terminal.data",
      at: now(),
      sessionId: this.session.id,
      data: withSynchronizedUpdate(update),
    };
    const payload = JSON.stringify(event);
    for (const client of this.clients) client.socket.send(payload);
  }
}

/**
 * The terminal bridge. One instance per daemon; connect sockets with
 * {@link handleOpen}.
 */
export class TerminalBridge {
  private readonly clients = new Set<ClientState>();
  private readonly streamers = new Map<string, PaneStreamer>();
  private readonly options: ResolvedOptions;

  constructor(
    private readonly deps: { tmux: Tmux; registry: SessionRegistry },
    options: TerminalBridgeOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Registers a freshly opened socket and wires its lifecycle callbacks. */
  handleOpen(socket: TerminalSocket): void {
    const client: ClientState = { socket, sessionId: null };
    this.clients.add(client);
    socket.onMessage((payload) => {
      void this.handleMessage(client, payload);
    });
    socket.onClose(() => this.handleClose(client));
  }

  handleClose(client: ClientState): void {
    if (client.sessionId !== null) this.detach(client);
    this.clients.delete(client);
  }

  /** Number of clients currently attached to a session (test/diagnostics hook). */
  clientCount(sessionId: string): number {
    return this.streamers.get(sessionId)?.clients.size ?? 0;
  }

  private async handleMessage(client: ClientState, payload: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return; // non-JSON frame: ignore
    }
    const parsed = terminalClientMessageSchema.safeParse(json);
    if (!parsed.success) return; // malformed message: ignore
    const message = parsed.data;
    switch (message.type) {
      case "terminal.attach":
        await this.attach(client, message.sessionId, message.cols, message.rows, false);
        break;
      case "terminal.reconnect":
        await this.attach(client, message.sessionId, message.cols, message.rows, true);
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
   * creates) its streamer, then replays scrollback + screen before the
   * broadcast stream continues.
   */
  private async attach(
    client: ClientState,
    sessionId: string,
    cols: number,
    rows: number,
    reconnect: boolean,
  ): Promise<void> {
    const session = this.deps.registry.getSession(sessionId);
    if (!session) {
      client.socket.close(CLOSE_UNKNOWN_SESSION, "unknown session");
      return;
    }
    const alive = await this.deps.tmux.hasSession(session.tmuxSession).catch(() => false);
    if (!alive) {
      client.socket.close(CLOSE_SESSION_GONE, "tmux session no longer exists");
      return;
    }
    if (client.sessionId !== null && client.sessionId !== sessionId) {
      this.detach(client);
    }

    let streamer = this.streamers.get(sessionId);
    if (!streamer || streamer.isDisposed) {
      streamer = new PaneStreamer(session, this.deps.tmux, this.options, (s) => {
        const current = this.streamers.get(sessionId);
        if (current === s) this.streamers.delete(sessionId);
      });
      streamer.rows = rows;
      this.streamers.set(sessionId, streamer);
    }

    // Adopt the attaching client's size (last attach wins, like tmux's own
    // client handling) unless the streamer already matches.
    if (streamer.rows !== rows) {
      streamer.rows = rows;
      await this.deps.tmux.resize(session.tmuxSession, cols, rows).catch(() => {});
    }

    // Capture the replay before joining the broadcast group, so the scrollback
    // snapshot and the stream cannot interleave mid-frame.
    let replayData: string;
    try {
      const result = await this.deps.tmux.run([
        "capture-pane",
        "-p",
        "-e",
        "-t",
        session.tmuxSession,
        "-S",
        `-${this.options.scrollbackLines}`,
      ]);
      const { history, screen } = splitCapture(result.stdout, streamer.rows);
      replayData = fullRepaint(history, screen);
    } catch {
      client.socket.close(CLOSE_SESSION_GONE, "tmux session no longer exists");
      return;
    }

    streamer.addClient(client);
    client.sessionId = sessionId;
    const attached: TerminalServerEvent = {
      type: "terminal.attached",
      at: now(),
      sessionId,
      resumed: reconnect,
    };
    client.socket.send(JSON.stringify(attached));
    client.socket.send(
      JSON.stringify({
        type: "terminal.data",
        at: now(),
        sessionId,
        data: replayData,
      } satisfies TerminalServerEvent),
    );
    // Align the shared model with the replay so the next poll emits a clean
    // full repaint for the whole group (cheap, and removes any race between
    // the replay snapshot and concurrently broadcast frames).
    streamer.invalidate();
  }

  /** Forwards UTF-8 input to the pane via hex `send-keys`, chunked. */
  private async sendInput(client: ClientState, sessionId: string, data: string): Promise<void> {
    if (client.sessionId !== sessionId) return;
    const session = this.deps.registry.getSession(sessionId);
    if (!session) return;
    const bytes = Buffer.from(data, "utf8");
    if (bytes.length === 0 || bytes.length > this.options.maxInputBytes) return;

    const chunkSize = this.options.inputChunkBytes;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      const hexArgs = [...chunk].map((byte) => byte.toString(16).padStart(2, "0"));
      try {
        await this.deps.tmux.run([
          "send-keys",
          "-t",
          session.tmuxSession,
          "-H",
          ...hexArgs,
        ]);
      } catch {
        return; // pane gone; the poller reports `terminal.exited`
      }
    }
    // Keystrokes usually produce immediate output — poll right away.
    this.streamers.get(sessionId)?.poke();
  }

  private async resize(
    client: ClientState,
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    if (client.sessionId !== sessionId) return;
    const streamer = this.streamers.get(sessionId);
    if (!streamer) return;
    await streamer.resize(cols, rows);
  }

  private detach(client: ClientState): void {
    const sessionId = client.sessionId;
    client.sessionId = null;
    if (sessionId === null) return;
    const streamer = this.streamers.get(sessionId);
    if (!streamer) return;
    streamer.removeClient(client);
  }
}
