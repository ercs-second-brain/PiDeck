/**
 * Event-driven pane output source (issue #67).
 *
 * tmux gives us two ways to learn that a pane produced output:
 *
 * 1. `pipe-pane -o -t <pane> 'cat >> <file>'` — tmux spawns the command
 *    immediately, and every byte the pane process writes to its pty is
 *    appended to the stream file with sub-millisecond latency. A
 *    `fs.watch` on that file turns each append into a wakeup, so the
 *    bridge captures (screen-only) and broadcasts within a few
 *    milliseconds of the output — no polling interval in the latency path.
 * 2. A (fallback) poll loop, used when the event source is unavailable —
 *    e.g. environments without inotify support, or when the stream file
 *    never appears.
 *
 * The stream file's *content* is ignored; only "it grew" matters (the
 * rendered screen state is always re-read via `capture-pane`). The file is
 * kept bounded: it is truncated (async) whenever it exceeds
 * `maxStreamFileBytes` and the last truncate was ≥ `truncateIntervalMs` ago.
 *
 * If `fs.watch` cannot be established (unsupported platform or ENOENT
 * races), the source reports failure once and the caller falls back to its
 * timer-based polling.
 */

import {
  createWriteStream,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  statSync,
  truncate,
  unlinkSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Tmux } from "../sessions/tmux.js";

export interface PaneEventSourceOptions {
  /** Give up if the stream file has not appeared after this long (ms). */
  streamStartTimeoutMs?: number;
  /** Truncate the stream file when it exceeds this many bytes. */
  maxStreamFileBytes?: number;
  /** Minimum time between truncations (ms). */
  truncateIntervalMs?: number;
}

interface ResolvedEventSourceOptions {
  streamStartTimeoutMs: number;
  maxStreamFileBytes: number;
  truncateIntervalMs: number;
}

const EVENT_SOURCE_DEFAULTS: ResolvedEventSourceOptions = {
  streamStartTimeoutMs: 350,
  maxStreamFileBytes: 512 * 1024,
  truncateIntervalMs: 4000,
};

export type EventSourceState = "starting" | "active" | "stopped";

/**
 * One pipe-pane stream per tmux pane target. Owns the stream directory, the
 * watcher, and the truncation policy. Clean up with {@link dispose}.
 */
export class PaneEventSource {
  private readonly tmux: Tmux;
  private readonly paneTarget: string;
  private readonly options: ResolvedEventSourceOptions;
  private readonly onChange: () => void;

  private streamDir: string | undefined;
  private streamFile: string | undefined;
  private watcher: FSWatcher | undefined;
  private verifyTimer: ReturnType<typeof setTimeout> | undefined;
  private truncating = false;
  private lastTruncateAt = 0;
  private lifecycle: EventSourceState = "starting";

  constructor(
    tmux: Tmux,
    paneTarget: string,
    onChange: () => void,
    options: PaneEventSourceOptions = {},
  ) {
    this.tmux = tmux;
    this.paneTarget = paneTarget;
    this.onChange = () => {
      if (this.state === "active") onChange();
    };
    this.options = { ...EVENT_SOURCE_DEFAULTS, ...options };
  }

  /** Current lifecycle state (diagnostics). */
  get state(): EventSourceState {
    return this.lifecycle;
  }

  /**
   * Starts the pipe-pane stream and the watcher. Resolves to `true` when the
   * stream file appeared and is being watched (event-driven captures are
   * armed); `false` when the stream could not be established and the caller
   * should fall back to timer polling. Never rejects.
   */
  async start(): Promise<boolean> {
    if (this.lifecycle === "stopped") return false;
    this.streamDir = mkdtempSync(path.join(tmpdir(), "agentskiss-term-"));
    this.streamFile = path.join(this.streamDir, `${safeName(this.paneTarget)}.stream`);

    // Reserve the stream file (open the write end like the real pipe shell
    // would, so fs.watch can be established before output arrives). The file
    // appears when the stream's open callback runs; wait for it so `watch`
    // (inotify add-watch) cannot race the creation.
    const file = this.streamFile;
    const reserved = new Promise<void>((resolve) => {
      const stream = createWriteStream(file, { flags: "a" });
      stream.end(() => resolve());
    });
    this.watcher = this.watchStreamFile(file);
    if (this.watcher === undefined) {
      // Either fs.watch is unsupported or the open callback had not run yet:
      // retry briefly once the reservation landed before giving up.
      await reserved;
      for (let i = 0; i < 25 && this.watcher === undefined; i++) {
        this.watcher = this.watchStreamFile(file);
        if (this.watcher === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } else {
      await reserved;
    }

    try {
      await this.tmux.run(["pipe-pane", "-o", "-t", this.paneTarget, `cat >> ${this.streamFile}`]);
    } catch {
      // Pane died between hasSession and pipe-pane; cleanup below reports it.
      this.dispose();
      return false;
    }

    // One-shot verify scan: the stream file must have appeared (and still be
    // watched) shortly after startup. Otherwise demote to timer polling.
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + this.options.streamStartTimeoutMs;
      const scan = () => {
        if (this.lifecycle === "stopped") return resolve();
        if (this.watcher !== undefined && existsSize(this.streamFile) !== null) return resolve();
        if (Date.now() > deadline) {
          // Stream never appeared: demote to timer polling and tear the
          // pipe down so the stream file cannot grow unbounded.
          this.dispose();
          return resolve();
        }
        this.verifyTimer = setTimeout(scan, 50);
      };
      scan();
    });
    if (this.watcher === undefined) return false;
    this.lifecycle = "active";
    return true;
  }

  /** Whether event-driven wakeups are armed (fallback polling is not needed). */
  get isEventDriven(): boolean {
    return this.state === "active" && this.watcher !== undefined;
  }

  /**
   * Keeps the stream file bounded (call after each capture): truncate when it
   * exceeds the size cap and the last truncate was long enough ago.
   */
  maybeTruncate(): void {
    const file = this.streamFile;
    if (file === undefined || this.lifecycle !== "active" || this.truncating) return;
    const size = existsSize(file);
    if (size === null || size <= this.options.maxStreamFileBytes) return;
    const sinceLast = Date.now() - this.lastTruncateAt;
    if (sinceLast < this.options.truncateIntervalMs) return;
    this.truncating = true;
    truncate(file, 0, () => {
      this.lastTruncateAt = Date.now();
      this.truncating = false;
    });
  }

  /** Stops the tmux pipe, all watchers; removes the stream directory. */
  dispose(): void {
    if (this.lifecycle === "stopped") return;
    const dir = this.streamDir;
    this.lifecycle = "stopped";
    this.stopWatcher();
    if (this.verifyTimer !== undefined) {
      clearTimeout(this.verifyTimer);
      this.verifyTimer = undefined;
    }
    // Stop the pipe itself (fire-and-forget: the pane may already be gone).
    void this.tmux.run(["pipe-pane", "-t", this.paneTarget]).catch(() => {});
    // Deferred so an in-flight `cat >>` write isn't racing the deletion.
    setTimeout(() => {
      if (dir === undefined) return;
      try {
        for (const name of readdirSafe(dir)) {
          try {
            unlinkSync(path.join(dir, name));
          } catch {
            // best effort
          }
        }
        rmdirSafe(dir);
      } catch {
        // best effort
      }
    }, 150).unref();
  }

  private stopWatcher(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  /**
   * Establishes `fs.watch` on the stream file, with an error guard. Without
   * an `error` listener, a watcher failure (macOS FSEvents hiccup, ENOENT
   * race after the file is truncated/removed) surfaces as an uncaught
   * exception that kills the whole daemon (issue #100). Here a watcher
   * error just demotes the pane to timer polling.
   */
  private watchStreamFile(file: string): FSWatcher | undefined {
    try {
      const watcher = watch(file, () => this.onChange());
      watcher.on("error", (err) => this.onWatcherError(err));
      return watcher;
    } catch {
      return undefined;
    }
  }

  private onWatcherError(err: Error): void {
    this.stopWatcher();
    console.error(
      `[terminal] event source watcher failed for ${this.paneTarget} (${err.message}); falling back to timer polling`,
    );
  }
}

/** Turns a pane target into a filesystem-safe file stem. */
function safeName(target: string): string {
  return target.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function existsSize(file: string | undefined): number | null {
  if (file === undefined) return null;
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function rmdirSafe(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    // best effort
  }
}
