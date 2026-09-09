/**
 * Tests for the sidebar's running-time clock (issues #182, #267): the
 * clock ticks every second so a running worker's duration label advances
 * 1s→1s instead of jumping in 5s steps. The tick mechanics are a plain
 * start/stop factory, so they are exercised with fake timers — no DOM
 * needed; the hook itself only pins the SSR-stable initial value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { startTickingClock, useTickingNow, WORKER_CLOCK_TICK_MS } from "./use-ticking-now";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("running-time clock tick (issue #267)", () => {
  it("defaults to a one-second tick", () => {
    expect(WORKER_CLOCK_TICK_MS).toBe(1_000);
  });

  it("fires onTick with the current time every second", () => {
    vi.setSystemTime(1_000_000);
    const ticks: number[] = [];
    startTickingClock((now) => ticks.push(now));
    vi.advanceTimersByTime(3_500);
    // Ticks at 1s, 2s, 3s — and each carries the clock at that moment.
    expect(ticks).toHaveLength(3);
    expect(ticks[0]).toBe(1_001_000);
    expect(ticks[2]).toBe(1_003_000);
  });

  it("stop function tears the clock down", () => {
    vi.setSystemTime(0);
    const ticks: number[] = [];
    const stop = startTickingClock((now) => ticks.push(now));
    vi.advanceTimersByTime(2_000);
    stop();
    vi.advanceTimersByTime(5_000);
    expect(ticks).toHaveLength(2);
  });

  it("hook renders an SSR-stable initial value (no first-paint flicker)", () => {
    vi.setSystemTime(5_000_000);
    let rendered: number | undefined;
    function Probe() {
      rendered = useTickingNow();
      return null;
    }
    renderToString(<Probe />);
    expect(rendered).toBe(5_000_000);
  });
});
