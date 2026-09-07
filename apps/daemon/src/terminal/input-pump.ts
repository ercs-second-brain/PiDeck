/**
 * Per-streamer input pump (issue #67): coalesces keystroke bursts into few,
 * large `send-keys` invocations.
 *
 * `send()` appends bytes and arms a short flush window (macrotask timer);
 * keystrokes arriving while a flush is already in flight are drained into
 * the next batch, so a burst of N keystrokes costs ~1 tmux process instead
 * of N. The output capture is triggered once per flush, not per keystroke.
 */

import type { Tmux } from "../sessions/tmux.js";

export interface InputPumpOptions {
  /**
   * Input flush window (ms): keystrokes arriving within one macrotask window
   * are coalesced into a single `send-keys` invocation. 0 flushes on the next
   * macrotask tick.
   */
  inputFlushMs: number;
  /** Bytes of input forwarded per `send-keys` invocation. */
  inputChunkBytes: number;
}

export class InputPump {
  private pending: Buffer = Buffer.alloc(0);
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;
  private disposed = false;
  /** Observability hook for tests/benchmarks: completed flushes. */
  readonly flushLog: number[] = [];

  constructor(
    private readonly tmux: Tmux,
    private readonly paneTarget: () => string | null,
    private readonly options: InputPumpOptions,
    private readonly onFlushed: () => void,
    private readonly onError: () => void,
  ) {}

  /** Appends input bytes to the pending buffer and arms the flush. */
  send(data: string): void {
    if (this.disposed) return;
    this.pending = Buffer.concat([this.pending, Buffer.from(data, "utf8")]);
    if (this.flushTimer === undefined && !this.flushing) {
      this.flushTimer = setTimeout(() => void this.flush(), this.options.inputFlushMs);
    }
  }

  /** Sends the pending bytes in as few `send-keys` invocations as possible. */
  async flush(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.flushing) return; // the in-flight drain loop picks this up
    this.flushing = true;
    try {
      for (;;) {
        const batch = this.pending;
        this.pending = Buffer.alloc(0);
        if (batch.length === 0) break;
        this.flushLog.push(batch.length);
        const target = this.paneTarget();
        if (target === null) break;
        const ok = await this.sendBatch(target, batch);
        if (!ok) {
          // Pane gone (or tmux hiccup): drop the batch; the poller reports
          // `terminal.exited` once the pane is really gone.
          this.onError();
          break;
        }
        // Drain input that arrived while the tmux invocation was in flight.
        if (this.pending.length === 0) break;
      }
    } finally {
      this.flushing = false;
      if (this.pending.length > 0 && !this.disposed && this.flushTimer === undefined) {
        this.flushTimer = setTimeout(() => void this.flush(), 0);
      }
    }
    if (this.disposed) return;
    this.onFlushed();
  }

  /** Chunked hex `send-keys`; false when an invocation failed. */
  private async sendBatch(target: string, batch: Buffer): Promise<boolean> {
    for (let offset = 0; offset < batch.length; offset += this.options.inputChunkBytes) {
      const chunk = batch.subarray(offset, Math.min(offset + this.options.inputChunkBytes, batch.length));
      try {
        await this.tmux.run([
          "send-keys",
          "-t",
          target,
          "-H",
          ...[...chunk].map((byte) => byte.toString(16).padStart(2, "0")),
        ]);
      } catch {
        return false;
      }
    }
    return true;
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pending = Buffer.alloc(0);
  }
}
