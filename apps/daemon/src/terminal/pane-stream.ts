/**
 * Per-session output pump: raw pane bytes from `tmux pipe-pane` into a
 * ring buffer, broadcast to every attached socket.
 *
 * tmux appends every byte the pane writes to a stream file (`pipe-pane
 * ... 'cat >> <file>'`). The stream reads newly appended bytes (fs.watch
 * wakeups, with a poll fallback when a watcher cannot be established),
 * pushes them into the ring buffer and forwards them to attached clients.
 * The stream stays armed after the last client detaches so the ring buffer
 * keeps accumulating recent scrollback for reconnects; when the tmux
 * session is gone and nobody is watching, the stream disposes itself.
 *
 * Pane output passes through byte-for-byte: nothing is captured, diffed or
 * re-rendered server-side. The one exception is replay replacement after a
 * size change (see {@link recapture}): the raw bytes for the old geometry
 * are swapped for a fresh `capture-pane` of the resized screen.
 */

import {
  closeSync,
  ftruncateSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RingBuffer } from "./ring-buffer.js";
import type { Tmux } from "../sessions/tmux.js";

export interface PaneStreamOptions {
  /** Ring buffer capacity in bytes (recent scrollback kept for replay). */
  ringBytes: number;
  /** Scrollback lines captured once to seed an otherwise empty buffer. */
  scrollbackLines: number;
  /** Truncate the stream file at this size once fully drained. */
  maxStreamFileBytes: number;
  /** Poll interval (ms) used when fs.watch is unavailable. */
  pollMs: number;
}

export interface PaneStreamClient {
  send(payload: string): void;
}

/** How often an idle stream checks whether its tmux session still exists. */
const IDLE_CHECK_MS = 15_000;
/** Upper bound per read call; large bursts drain over several ticks. */
const MAX_READ_BYTES = 1024 * 1024;

interface ClientEntry {
  /** Live broadcasts are skipped until the replay has been delivered. */
  ready: boolean;
}

export class PaneStream {
  readonly clients = new Map<PaneStreamClient, ClientEntry>();
  private readonly ring: RingBuffer;
  private dir: string | undefined;
  private file: string | undefined;
  private fd: number | undefined;
  private offset = 0;
  private watcher: FSWatcher | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private drainScheduled = false;
  private seedPromise: Promise<void> | undefined;
  private disposed = false;

  constructor(
    readonly sessionId: string,
    readonly tmuxSession: string,
    private readonly tmux: Tmux,
    private readonly options: PaneStreamOptions,
    private readonly log: (line: string) => void,
    private readonly onDisposed: (stream: PaneStream) => void,
  ) {
    this.ring = new RingBuffer(options.ringBytes);
    this.idleTimer = setInterval(() => void this.checkIdle(), IDLE_CHECK_MS);
    this.idleTimer.unref?.();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Bytes retained for replay (test/diagnostics hook). */
  get bufferedBytes(): number {
    return this.ring.size;
  }

  /**
   * Arms the pipe-pane stream. Resolves `true` when the stream is running;
   * `false` when it could not be established (the pane is gone). Never
   * rejects.
   */
  async start(): Promise<boolean> {
    this.dir = mkdtempSync(path.join(tmpdir(), "pideck-term-"));
    this.file = path.join(this.dir, "pane.stream");
    // Reserve the file so the watcher attaches before the first pipe write.
    closeSync(openSync(this.file, "a"));
    this.fd = openSync(this.file, "r");
    this.watcher = this.watchStreamFile();
    if (this.watcher === undefined) this.startPolling();
    try {
      // Without -o: tmux closes any pipe left over from a previous run and
      // opens ours, so a daemon restart re-pipes a pane that was still
      // piping into a deleted temp file.
      await this.tmux.run([
        "pipe-pane",
        "-t",
        this.tmuxSession,
        `cat >> ${shellQuote(this.file)}`,
      ]);
    } catch (err) {
      this.dispose();
      this.log(`[terminal] pipe-pane failed for ${this.tmuxSession}: ${String(err)}`);
      return false;
    }
    this.scheduleDrain();
    return true;
  }

  /** Number of currently attached clients (test/diagnostics hook). */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Seeds the ring buffer once (capture-pane scrollback) so the very first
   * attach to a quiet pane is not blank; then the live stream takes over.
   */
  ensureSeeded(): Promise<void> {
    this.seedPromise ??= this.seed();
    return this.seedPromise;
  }

  private async seed(): Promise<void> {
    if (this.disposed || this.ring.size > 0) return;
    await this.captureInto(false);
  }

  /**
   * Recaptures the pane after a size change: replaces the replay buffer
   * with a fresh capture of the screen as currently rendered, so clients
   * attaching at a new size never replay bytes drawn for the old one.
   * Falls back to the existing buffer when the capture fails.
   */
  async recapture(): Promise<Buffer> {
    if (this.disposed) return this.ring.replay();
    await this.captureInto(true);
    return this.ring.replay();
  }

  /** Captures the pane's scrollback and, when asked, replaces the buffer. */
  private async captureInto(replace: boolean): Promise<void> {
    if (this.disposed) return;
    try {
      const result = await this.tmux.run([
        "capture-pane",
        "-p",
        "-e",
        "-N",
        "-t",
        this.tmuxSession,
        "-S",
        `-${this.options.scrollbackLines}`,
      ]);
      if (this.disposed) return;
      if (result.stdout.length > 0) {
        // Capture output ends each line with a bare LF, but xterm only
        // returns to column 0 on CRLF — a full-width line followed by a
        // bare LF wraps and scrolls the screen. Live pty bytes already
        // carry CRLF; the capture needs it restored.
        const data = Buffer.from(result.stdout.replace(/\r?\n/g, "\r\n"), "utf8");
        if (replace) {
          this.ring.clear();
          this.ring.push(data);
        } else if (this.ring.size === 0) {
          this.ring.push(data);
        }
      }
    } catch {
      // Seeding is best-effort; the live stream still works.
    }
  }

  /** Marks a client as receiving output (it stops receiving until ready). */
  addClient(client: PaneStreamClient): void {
    this.clients.set(client, { ready: false });
  }

  /** Releases a client's replay hold after the replay was sent. */
  markReady(client: PaneStreamClient): void {
    const entry = this.clients.get(client);
    if (entry) entry.ready = true;
  }

  removeClient(client: PaneStreamClient): void {
    this.clients.delete(client);
  }

  private broadcast(data: Buffer): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify({
      type: "terminal.data",
      sessionId: this.sessionId,
      data: data.toString("utf8"),
    });
    for (const [client, entry] of this.clients) {
      if (entry.ready) client.send(payload);
    }
  }

  /** Everything retained in the ring buffer, for attach/reconnect replay. */
  replay(): Buffer {
    return this.ring.replay();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        // already closed
      }
      this.fd = undefined;
    }
    void this.tmux.run(["pipe-pane", "-t", this.tmuxSession]).catch(() => {});
    if (this.dir !== undefined) {
      try {
        rmSync(this.dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
      this.dir = undefined;
    }
    this.onDisposed(this);
  }

  private async checkIdle(): Promise<void> {
    if (this.disposed || this.clients.size > 0) return;
    const alive = await this.tmux.hasSession(this.tmuxSession).catch(() => false);
    if (!alive && !this.disposed) this.dispose();
  }

  private watchStreamFile(): FSWatcher | undefined {
    const file = this.file;
    if (file === undefined) return undefined;
    try {
      const watcher = watch(file, () => this.scheduleDrain());
      watcher.on("error", () => {
        this.watcher = undefined;
        this.startPolling();
      });
      return watcher;
    } catch {
      return undefined;
    }
  }

  private startPolling(): void {
    if (this.pollTimer !== undefined || this.disposed) return;
    this.pollTimer = setInterval(() => this.scheduleDrain(), this.options.pollMs);
    this.pollTimer.unref?.();
  }

  /** Coalesces watcher/poll wakeups into at most one pending drain. */
  private scheduleDrain(): void {
    if (this.drainScheduled || this.disposed) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  private drain(): void {
    const fd = this.fd;
    if (this.disposed || fd === undefined) return;
    let data: Buffer;
    try {
      const size = fstatSync(fd).size;
      let length = size - this.offset;
      if (length <= 0) return;
      length = Math.min(length, MAX_READ_BYTES);
      data = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = readSync(fd, data, read, length - read, this.offset + read);
        if (n <= 0) break;
        read += n;
      }
      data = data.subarray(0, read);
      this.offset += read;
      // Only truncate when fully drained: bytes appended between the read
      // and the truncate would otherwise be lost.
      if (this.offset === size && size > this.options.maxStreamFileBytes) {
        try {
          ftruncateSync(fd, 0);
          this.offset = 0;
        } catch {
          // best effort; growth is bounded by drain frequency anyway
        }
      }
    } catch {
      return; // transient fs error; the next wakeup retries
    }
    if (data.length === 0) return;
    this.ring.push(data);
    this.broadcast(data);
  }
}

/** Quotes a path for use inside the pipe-pane shell command. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}