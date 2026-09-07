/**
 * Daemon runtime stats (issue #100, phase 1): event-loop lag, memory, and
 * uptime — surfaced in `GET /api/status` so slow/unstable installs can be
 * diagnosed from a user report without attaching a debugger.
 *
 * Event-loop lag is measured with `perf_hooks.monitorEventLoopDelay`: the
 * histogram is reset and re-summarized once per second, so `p99`/`max`
 * describe the last minute-ish window (bounded by `windowMs`) rather than
 * process lifetime. All timers are unref'd; a daemon that never calls
 * `stop()` still exits cleanly.
 */

import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export interface RuntimeStatsSnapshot {
  /** Process uptime in seconds (`process.uptime()`). */
  uptimeSeconds: number;
  rssBytes: number;
  heapUsedBytes: number;
  /** p99 event-loop delay over the sampling window, in ms. */
  eventLoopLagP99Ms: number;
  /** Max event-loop delay over the sampling window, in ms. */
  eventLoopLagMaxMs: number;
}

export interface RuntimeStatsOptions {
  /** Histogram recompute cadence (ms). */
  sampleIntervalMs?: number;
  /** How far back the p99/max window reaches (ms). */
  windowMs?: number;
}

const DEFAULTS: Required<RuntimeStatsOptions> = {
  sampleIntervalMs: 1000,
  windowMs: 60_000,
};

export class RuntimeStats {
  private readonly histogram = monitorEventLoopDelay({ resolution: 20 });
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly windowMs: number;
  private readonly samples: Array<{ at: number; p99Ms: number; maxMs: number }> = [];
  private lastP99Ms = 0;
  private lastMaxMs = 0;

  constructor(options: RuntimeStatsOptions = {}) {
    const resolved = { ...DEFAULTS, ...options };
    this.windowMs = resolved.windowMs;
    this.histogram.enable();
    this.timer = setInterval(() => this.sample(), resolved.sampleIntervalMs);
    this.timer.unref();
  }

  private sample(): void {
    // Read + reset: each sample describes one interval; the window p99/max
    // is the worst interval in the last `windowMs`.
    const p99Ms = this.histogram.percentile(99) / 1e6;
    const maxMs = this.histogram.max / 1e6;
    this.histogram.reset();
    const at = performance.now();
    this.samples.push({ at, p99Ms, maxMs });
    while (this.samples.length > 0 && at - (this.samples[0]?.at ?? at) > this.windowMs) {
      this.samples.shift();
    }
    this.lastP99Ms = Math.max(...this.samples.map((s) => s.p99Ms));
    this.lastMaxMs = Math.max(...this.samples.map((s) => s.maxMs));
  }

  snapshot(): RuntimeStatsSnapshot {
    const memory = process.memoryUsage();
    return {
      uptimeSeconds: Math.round(process.uptime()),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      eventLoopLagP99Ms: Math.round(this.lastP99Ms * 100) / 100,
      eventLoopLagMaxMs: Math.round(this.lastMaxMs * 100) / 100,
    };
  }

  /** Stops the sampler (daemon shutdown; tests). */
  stop(): void {
    this.histogram.disable();
    clearInterval(this.timer);
  }
}
