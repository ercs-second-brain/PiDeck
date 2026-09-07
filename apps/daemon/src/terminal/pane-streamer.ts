/**
 * Per-session output pump (issues #7 and #67): captures the pane
 * (event-driven, with a poll safety net), diffs, broadcasts. Lives while at
 * least one client is attached; tmux itself keeps the pane running without
 * any streamer.
 *
 * Output signaling (issue #67): a {@link PaneEventSource} (`pipe-pane` +
 * `fs.watch`) triggers captures the moment the pane writes output. Captures
 * are screen-only (`-S -<rows>`). The timer loop is a safety net while the
 * stream is healthy and the primary signal when it is not.
 */

import type { Session, TerminalServerEvent } from "@agentskiss/shared";
import type { Tmux } from "../sessions/tmux.js";
import { PaneEventSource } from "./event-source.js";
import { InputPump } from "./input-pump.js";
import type { TerminalSocket } from "./bridge.js";
import {
  frameUpdate,
  screenRepaint,
  splitCapture,
  withSynchronizedUpdate,
} from "./screen.js";

/** Minimal per-socket bridge state; lives in the bridge's client set. */
export interface ClientState {
  readonly socket: TerminalSocket;
  sessionId: string | null;
}

export function now(): string {
  return new Date().toISOString();
}

/** Polls count as "active" for this long after the last observed change. */
const ACTIVE_WINDOW_MS = 1500;

export interface PaneStreamerOptions {
  activePollMs: number;
  idlePollMs: number;
  streamPollMs: number;
  inputChunkBytes: number;
  inputFlushMs: number;
  disableEventSource: boolean;
}

export class PaneStreamer {
  readonly clients = new Set<ClientState>();

  /** Visible-screen model rows; `[]` means "resync pending". */
  private model: string[] = [];
  /** The row count the model is split against (last client-reported size). */
  rows = 24;
  /** Coalesces keystroke bursts into few `send-keys` invocations (issue #67). */
  private readonly inputPump: InputPump;
  /** Event-driven output source (`pipe-pane` + `fs.watch`), if healthy. */
  private eventSource: PaneEventSource | undefined;
  private eventDriven = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private lastChangeAt = 0;
  /** Serializes captures (event + timer triggers must not interleave). */
  private capturing = false;
  private captureQueued = false;

  constructor(
    readonly session: Session,
    private readonly tmux: Tmux,
    private readonly options: PaneStreamerOptions,
    private readonly onDisposed: (streamer: PaneStreamer) => void,
  ) {
    this.inputPump = new InputPump(
      tmux,
      () => (this.disposed ? null : session.tmuxSession),
      { inputFlushMs: options.inputFlushMs, inputChunkBytes: options.inputChunkBytes },
      () => {
        // Keystrokes usually produce immediate output — poll right away.
        this.capture();
      },
      () => {
        this.invalidate();
      },
    );
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Current model screen (may be empty while a resync is pending). */
  get screen(): string[] {
    return this.model;
  }

  /**
   * Starts the event-driven output stream (best effort). Resolves when the
   * stream is armed or has failed (in which case the timer loop is the
   * output signal).
   */
  async startEventStream(): Promise<void> {
    if (this.disposed || this.options.disableEventSource) return;
    const source = new PaneEventSource(
      this.tmux,
      this.session.tmuxSession,
      () => this.capture(),
      {},
    );
    this.eventSource = source;
    const armed = await source.start().catch(() => false);
    if (this.disposed) return;
    if (source.state === "active" && armed) {
      this.eventDriven = true;
      // One immediate catch-up capture: anything the pane produced while the
      // stream was starting must not wait for a timer.
      this.capture();
    }
  }

  addClient(client: ClientState): void {
    this.clients.add(client);
    this.capture();
  }

  removeClient(client: ClientState): void {
    this.clients.delete(client);
    if (this.clients.size === 0) this.dispose();
  }

  /**
   * Client-reported size changed: resize the tmux window and invalidate the
   * model so the next capture repaints every client's screen.
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
    this.capture();
  }

  /** Forces a full screen repaint on the next capture. */
  invalidate(): void {
    this.model = [];
    this.capture();
  }

  /** Coalesced input flush entry point (see {@link InputPump}). */
  sendInput(data: string): void {
    this.inputPump.send(data);
  }

  dispose(): void {
    this.disposed = true;
    this.inputPump.dispose();
    this.eventSource?.dispose();
    this.eventSource = undefined;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.onDisposed(this);
  }

  private schedule(delayMs: number): void {
    if (this.disposed) return;
    this.timer = setTimeout(() => void this.capture(), delayMs);
  }

  /**
   * Runs one capture-diff-broadcast cycle; triggers from the event source and
   * the timers are serialized so frames cannot interleave mid-diff.
   */
  private capture(): void {
    if (this.disposed) return;
    if (this.capturing) {
      this.captureQueued = true;
      return;
    }
    this.capturing = true;
    void this.captureNow().finally(() => {
      this.capturing = false;
      if (this.captureQueued) {
        this.captureQueued = false;
        this.capture();
      }
    });
  }

  private async captureNow(): Promise<void> {
    this.timer = undefined;

    const raw = await this.captureScreenOrDetectExit();
    if (raw === null) return; // exited() handled disposal + notification

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

    this.eventSource?.maybeTruncate();

    if (this.eventDriven) {
      // Event-driven wakeups are the primary signal; the timer only serves
      // as a low-frequency safety net.
      this.schedule(this.options.streamPollMs);
      return;
    }
    const active = Date.now() - this.lastChangeAt < ACTIVE_WINDOW_MS;
    this.schedule(active ? this.options.activePollMs : this.options.idlePollMs);
  }

  /**
   * Screen-only capture (`-S -<rows>`); `null` when the pane died (already
   * reported via `terminal.exited`) or tmux hiccuped (retry scheduled).
   */
  private async captureScreenOrDetectExit(): Promise<string | null> {
    try {
      const result = await this.tmux.run([
        "capture-pane",
        "-p",
        "-e",
        "-t",
        this.session.tmuxSession,
        "-S",
        `-${this.rows}`,
      ]);
      return result.stdout;
    } catch {
      const alive = await this.tmux.hasSession(this.session.tmuxSession).catch(() => false);
      if (!alive) {
        this.exited();
        return null;
      }
      this.schedule(this.options.idlePollMs);
      return null;
    }
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
