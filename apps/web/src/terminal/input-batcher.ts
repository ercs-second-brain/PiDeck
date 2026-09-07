/**
 * Input coalescing for the web terminal (issue #67): batches the rapid
 * `onData` bursts xterm.js produces while a key is held down (or a burst of
 * keys is typed) into fewer, larger WebSocket frames.
 *
 * Every call appends to a pending buffer and schedules a flush on the next
 * macrotask, so all keystrokes delivered within one event-loop tick leave as
 * one frame instead of one frame per key. Two guard rails keep latency and
 * ordering sane:
 *
 * - Boundary keystrokes (Enter, Tab, Escape, and control sequences) flush
 *   early — everything already pending is sent before them, so commands are
 *   submitted promptly without waiting for the next tick.
 * - If a flush keeps being starved (the environment never yields to a new
 *   macrotask for `maxBatchDelayMs`), a timer forces one so input cannot be
 *   held hostage.
 */

/** Keystrokes that must not be merged into a later frame (command boundaries). */
const BOUNDARY_KEYS = new Set(["\r", "\n", "\t", "\x1b", "\x03", "\x04", "\x1a"]);

/** Longest time input may stay pending before a forced flush (ms). */
const MAX_BATCH_DELAY_MS = 16;

export class InputBatcher {
  private pending = "";
  private scheduled = false;
  private oldestAt = 0;
  private forceTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly send: (data: string) => void,
    private readonly maxBatchDelayMs: number = MAX_BATCH_DELAY_MS,
  ) {}

  /** Appends keystroke data to the pending batch and schedules a flush. */
  add(data: string): void {
    if (this.closed || data.length === 0) return;
    if (this.pending.length === 0) this.oldestAt = Date.now();
    this.pending += data;
    // A boundary keystroke ends the batch: send everything so far now.
    const last = data[data.length - 1];
    if (last !== undefined && BOUNDARY_KEYS.has(last)) {
      void this.flush();
      return;
    }
    this.schedule();
  }

  /** Sends the pending batch immediately (also used by the forced flush). */
  flush(): void {
    if (this.forceTimer !== undefined) {
      clearTimeout(this.forceTimer);
      this.forceTimer = undefined;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = "";
    this.scheduled = false;
    this.send(batch);
  }

  /** Stops batching; sends anything still pending. */
  close(): void {
    this.closed = true;
    this.flush();
  }

  private schedule(): void {
    if (this.scheduled) {
      // Starvation guard: if the batch is older than the max delay, force a
      // flush on a timer (the macrotask queue may be saturated).
      if (Date.now() - this.oldestAt >= this.maxBatchDelayMs && this.forceTimer === undefined) {
        this.forceTimer = setTimeout(() => {
          this.forceTimer = undefined;
          this.flush();
        }, 0);
      }
      return;
    }
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.flush();
    }, 0);
  }
}
