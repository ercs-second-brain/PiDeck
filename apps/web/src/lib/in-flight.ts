/**
 * In-flight request coalescing (issue #88).
 *
 * A `Map` from request key → shared promise. Concurrent identical requests
 * (same key) join the first caller's promise instead of stacking their own
 * network request; the entry is dropped when it settles so the next request
 * after completion starts fresh (and a failed request is retried, not
 * cached).
 *
 * This is what keeps the app from piling up unbounded pending requests when
 * the daemon (or an upstream GitHub fetch behind it) is slow: poll ticks,
 * mount effects, and websocket-event refetches all converge on one promise
 * per resource.
 */

/** Shared promises keyed by request key; pass one per consumer (store, api lib). */
export type InFlight<T> = Map<string, Promise<T>>;

/**
 * Returns the shared in-flight promise for `key`, or starts `run()` and
 * shares it. Rejections propagate to every sharer and clear the entry, so
 * later callers retry. A settled entry only evicts itself: if the key was
 * replaced while this promise was pending (write invalidation, #203), the
 * replacement stays.
 */
export function shareInFlight<T>(map: InFlight<T>, key: string, run: () => Promise<T>): Promise<T> {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const promise = run().finally(() => {
    if (map.get(key) === promise) map.delete(key);
  });
  map.set(key, promise);
  return promise;
}
