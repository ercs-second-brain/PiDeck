import { useEffect, useState } from "react";

/**
 * The sidebar's client-side clock for the workers' running-time labels
 * (issue #182): ticks every second (issue #267) so a running worker's
 * duration label advances 1s→1s. Kept in its own module so the tick
 * mechanics are unit-testable without a DOM — the React hook is a thin
 * wrapper over {@link startTickingClock}.
 */

/** How often the running-time clock ticks (issue #267: every second). */
export const WORKER_CLOCK_TICK_MS = 1_000;

/**
 * Starts `window.setInterval` calling `onTick(Date.now())` every
 * `intervalMs`; returns the stop function. (Separated from the hook so
 * fake-timer tests can exercise the actual tick/teardown behavior.)
 */
export function startTickingClock(onTick: (now: number) => void, intervalMs: number = WORKER_CLOCK_TICK_MS): () => void {
  const timer = setInterval(() => onTick(Date.now()), intervalMs);
  return () => clearInterval(timer);
}

/**
 * The ticking clock itself: starts at mount time (so SSR renders a stable
 * value) and re-renders once per tick with the current `Date.now()`.
 */
export function useTickingNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => startTickingClock(setNow), []);
  return now;
}
