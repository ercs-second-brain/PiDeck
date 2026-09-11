/**
 * WebSocket ⇄ tmux terminal bridge (issues #7 and #67).
 *
 * The bridge speaks the terminal message family from `@pideck/shared`
 * (`terminal.attach` / `data` / `resize` / `reconnect` / `detach` and the
 * `terminal.attached` / `data` / `exited` server events).
 *
 * Design (issue #67 perf rework):
 * - Input: per-streamer {@link InputPump} coalescing. Keystrokes arriving in
 *   a burst are accumulated in a pending buffer and flushed as few, larger
 *   `send-keys -H` invocations (a macrotask flush window plus in-flight
 *   draining) — one tmux process per burst instead of one per keystroke.
 * - Output: a per-streamer {@link PaneEventSource} (`pipe-pane` stream +
 *   `fs.watch`) triggers captures the moment the pane writes output; a
 *   slow timer loop (`streamPollMs`) only runs as a safety net while the
 *   event source is healthy, and takes over completely when it is not.
 * - Captures are screen-only (`-S -<rows>`, O(rows) instead of O(full
 *   scrollback)); the full scrollback is captured only for the replay on
 *   attach/reconnect. The diff/render protocol (`screen.ts`) and the wire
 *   semantics (replay, resize, multi-client broadcast, `terminal.exited`)
 *   are unchanged.
 * - Every attached client joins the streamer of its session
 *   (`pane-streamer.ts`), so multiple browser terminals can watch the same
 *   tmux pane concurrently. Attach/reconnect replays the captured
 *   scrollback before streaming, so a browser that reconnects after a
 *   network drop resumes exactly where the pane is (tmux keeps the pane
 *   alive regardless of clients).
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
} from "@pideck/shared";
import type { SessionRegistry } from "../sessions/registry.js";
import type { Tmux } from "../sessions/tmux.js";
import {
  cursorSequence,
  fullRepaint,
  splitCapture,
} from "./screen.js";
import { PaneStreamer, now, queryCursorState, type ClientState } from "./pane-streamer.js";

/** Minimal socket surface the bridge needs; implemented by `ws` and test fakes. */
export interface TerminalSocket {
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (payload: string) => void): void;
  onClose(cb: () => void): void;
}

export interface TerminalBridgeOptions {
  /**
   * Forces the timer-polling fallback (tests use it to simulate environments
   * without a working event source, e.g. no `fs.watch` support).
   */
  disableEventSource?: boolean;
  /**
   * Fallback poll interval (ms) while the pane is actively changing. Only
   * used when the event-driven stream is unavailable, or as the safety-net
   * cadence while it is healthy (see `streamPollMs`).
   */
  activePollMs?: number;
  /** Fallback poll interval (ms) while the pane looks idle. */
  idlePollMs?: number;
  /**
   * Safety-net poll cadence (ms) while the event-driven stream is healthy.
   * The stream is the primary output signal; this timer only catches signals
   * lost to watcher hiccups (and truncates the stream file).
   */
  streamPollMs?: number;
  /** Scrollback lines captured and replayed on attach/reconnect. */
  scrollbackLines?: number;
  /** Maximum accepted input size per `terminal.data` message, in bytes. */
  maxInputBytes?: number;
  /** Bytes of input forwarded per `send-keys` invocation. */
  inputChunkBytes?: number;
  /**
   * Input flush window (ms): keystrokes arriving within one macrotask window
   * are coalesced into a single `send-keys` invocation. 0 flushes on the next
   * macrotask tick.
   */
  inputFlushMs?: number;
  /** Log sink for connect/disconnect/diagnostic lines (default `console.log`). */
  log?: (line: string) => void;
}

interface ResolvedOptions {
  activePollMs: number;
  idlePollMs: number;
  streamPollMs: number;
  scrollbackLines: number;
  maxInputBytes: number;
  inputChunkBytes: number;
  inputFlushMs: number;
  disableEventSource: boolean;
  log: (line: string) => void;
}

const DEFAULTS: ResolvedOptions = {
  activePollMs: 50,
  idlePollMs: 250,
  streamPollMs: 500,
  scrollbackLines: 2000,
  maxInputBytes: 65_536,
  inputChunkBytes: 4096,
  inputFlushMs: 8,
  disableEventSource: false,
  log: (line) => console.log(line),
};

/** WebSocket close codes (4xxx = application-defined). */
export const CLOSE_UNKNOWN_SESSION = 4004;
export const CLOSE_SESSION_GONE = 4005;

/**
 * The terminal bridge. One instance per daemon; connect sockets with
 * {@link handleOpen}.
 */
export class TerminalBridge {
  private readonly clients = new Set<ClientState>();
  private readonly streamers = new Map<string, PaneStreamer>();
  /** In-flight streamer startups, keyed by session id (serializes joins). */
  private readonly joining = new Map<string, Promise<PaneStreamer | null>>();
  private readonly options: ResolvedOptions;
  private readonly log: (line: string) => void;

  constructor(
    private readonly deps: { tmux: Tmux; registry: SessionRegistry },
    options: TerminalBridgeOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
    this.log = this.options.log;
  }

  /** Registers a freshly opened socket and wires its lifecycle callbacks. */
  handleOpen(socket: TerminalSocket): void {
    const client: ClientState = { socket, sessionId: null };
    this.clients.add(client);
    this.log(`[terminal] client connected total=${this.clients.size}`);
    socket.onMessage((payload) => {
      void this.handleMessage(client, payload);
    });
    socket.onClose(() => this.handleClose(client));
  }

  handleClose(client: ClientState): void {
    if (client.sessionId !== null) this.detach(client);
    this.clients.delete(client);
    this.log(`[terminal] client disconnected total=${this.clients.size}`);
  }

  /** Number of clients currently attached to a session (test/diagnostics hook). */
  clientCount(sessionId: string): number {
    return this.streamers.get(sessionId)?.clients.size ?? 0;
  }

  /** Number of live pane streamers (test/diagnostics hook — leak detection). */
  get streamerCount(): number {
    return this.streamers.size;
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

    const streamer = await this.joinStreamer(session, rows);
    if (streamer === null) {
      client.socket.close(CLOSE_SESSION_GONE, "tmux session no longer exists");
      return;
    }

    // Adopt the attaching client's size (last attach wins, like tmux's own
    // client handling) — and push it to tmux on every attach. A fresh
    // streamer inherits its size from this very attach message, and the
    // tmux window may still sit at the detached default (80x24) or at a
    // previous client's size; skipping the resize left the pane rendering
    // at a stale, fixed size regardless of the browser viewport (issue
    // #124).
    streamer.rows = rows;
    streamer.cols = cols;
    await this.deps.tmux.resize(session.tmuxSession, cols, rows).catch(() => {});

    // Capture the replay before joining the broadcast group, so the scrollback
    // snapshot and the stream cannot interleave mid-frame.
    const replayData = await this.buildReplay(session, streamer.rows);
    if (replayData === null) {
      // The pane died mid-attach: if no client made it into the streamer,
      // dispose it — otherwise its pipe-pane stream + watcher + capture
      // timer would leak forever (issue #100).
      if (streamer.clients.size === 0) streamer.dispose();
      client.socket.close(CLOSE_SESSION_GONE, "tmux session no longer exists");
      return;
    }

    streamer.addClient(client);
    client.sessionId = sessionId;
    this.log(`[terminal] attach session=${sessionId} clients=${streamer.clients.size} resumed=${reconnect}`);
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
    // Align the shared model with the replay so the next capture emits a clean
    // full repaint for the whole group (cheap, and removes any race between
    // the replay snapshot and concurrently broadcast frames).
    streamer.invalidate();
  }

  /** Joins (or creates) the session's streamer, starting its event stream. */
  private async joinStreamer(session: Session, rows: number): Promise<PaneStreamer | null> {
    const existing = this.streamers.get(session.id);
    if (existing && !existing.isDisposed) return existing;
    // Serialize per session: two sockets attaching to the same session race
    // through the async streamer startup, and the loser would overwrite (and
    // orphan) the winner's streamer — a pipe-pane + watcher leak (issue #100).
    const inFlight = this.joining.get(session.id);
    if (inFlight) return inFlight;
    const created = this.createStreamer(session, rows).finally(() => this.joining.delete(session.id));
    this.joining.set(session.id, created);
    return created;
  }

  private async createStreamer(session: Session, rows: number): Promise<PaneStreamer | null> {
    const streamer = new PaneStreamer(session, this.deps.tmux, this.options, (s) => {
      const current = this.streamers.get(session.id);
      if (current === s) this.streamers.delete(session.id);
    });
    streamer.rows = rows;
    this.streamers.set(session.id, streamer);
    await streamer.startEventStream();
    if (streamer.isDisposed) return null;
    return streamer;
  }

  /**
   * Full scrollback + screen replay (attach/reconnect only — the capture
   * loop is screen-only), or `null` when the capture failed (pane gone).
   * Ends with the pane's true cursor state (issue #92): the client reset
   * its terminal, so the cursor must be placed before the first frame.
   */
  private async buildReplay(session: Session, rows: number): Promise<string | null> {
    try {
      const result = await this.deps.tmux.run([
        "capture-pane",
        "-p",
        "-e",
        // Preserve trailing spaces (issue #442): without -N, full-width
        // background bars capture as SGR-only lines and every row's end
        // state depends on trimmed cells, so bars render only when the
        // client parser's background happens to match.
        "-N",
        "-t",
        session.tmuxSession,
        "-S",
        `-${this.options.scrollbackLines}`,
      ]);
      const { history, screen } = splitCapture(result.stdout, rows);
      let replay = fullRepaint(history, screen);
      const cursor = await queryCursorState(this.deps.tmux, session.tmuxSession).catch(
        () => null,
      );
      if (cursor !== null) replay += cursorSequence(cursor, null);
      return replay;
    } catch {
      return null;
    }
  }

  /** Forwards UTF-8 input through the streamer's coalescing input pump. */
  private async sendInput(client: ClientState, sessionId: string, data: string): Promise<void> {
    if (client.sessionId !== sessionId) return;
    const session = this.deps.registry.getSession(sessionId);
    if (!session) return;
    const bytes = Buffer.from(data, "utf8");
    if (bytes.length === 0 || bytes.length > this.options.maxInputBytes) return;
    this.streamers.get(sessionId)?.sendInput(data);
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
    this.log(`[terminal] detach session=${sessionId} clients=${streamer.clients.size}`);
  }
}
