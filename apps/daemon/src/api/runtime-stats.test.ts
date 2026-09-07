/**
 * Runtime stats sampler (issue #100 phase 1): uptime/memory/event-loop lag
 * surfaced in `GET /api/status`.
 */

import { describe, expect, it, vi } from "vitest";

import { RuntimeStats } from "./runtime-stats.js";

describe("RuntimeStats", () => {
  it("snapshots uptime, memory, and event-loop lag fields", async () => {
    const stats = new RuntimeStats();
    vi.useFakeTimers();
    try {
      // One sampling interval passes: the histogram is read + reset.
      await vi.advanceTimersByTimeAsync(1100);
      const snap = stats.snapshot();
      expect(snap.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(snap.rssBytes).toBeGreaterThan(0);
      expect(snap.heapUsedBytes).toBeGreaterThan(0);
      expect(snap.eventLoopLagP99Ms).toBeGreaterThanOrEqual(0);
      expect(snap.eventLoopLagMaxMs).toBeGreaterThanOrEqual(0);
      // Lag stays sane for an idle loop (< one sample interval).
      expect(snap.eventLoopLagMaxMs).toBeLessThan(1100);
    } finally {
      vi.useRealTimers();
      stats.stop();
    }
  });

  it("stop() halts sampling without throwing", () => {
    const stats = new RuntimeStats();
    stats.stop();
    expect(() => stats.snapshot()).not.toThrow();
  });
});
