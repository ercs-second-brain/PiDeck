/**
 * Reconnect backoff for the terminal WebSocket: exponential growth capped at
 * 8s, with ±25% jitter so a daemon restart doesn't produce a reconnect storm.
 */

/** Base delay for reconnect attempt `n` (1-based), capped at 8s. */
export function backoffDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt - 1), 8000);
}

/** Jittered backoff: ±25% around the base so reconnect storms spread out. */
export function nextBackoffMs(attempt: number): number {
  return Math.round(backoffDelayMs(attempt) * (0.75 + Math.random() * 0.5));
}