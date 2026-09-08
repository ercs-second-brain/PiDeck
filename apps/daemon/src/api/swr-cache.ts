/**
 * TTL cache with stale-while-revalidate + single-flight background refresh,
 * shared by the daemon API's GitHub-backed listings (issues #40, #88) and,
 * since #131, by every daemon-side TTL/single-flight cache (pi-auth probe,
 * update checker) — the mechanics live here once; the users only pick
 * policy options.
 *
 * ## Request economy
 *
 * The webapp polls listings/boards; without a cache, every poll (and any
 * webapp request storm) became a GitHub API storm. The shared token is also
 * used by watchers/pipelines, so the API layer must be frugal:
 *
 * - cache fresh (age < TTL): **0 API calls**;
 * - cache stale (SWR mode): the stale value is served immediately and at
 *   most **1 background refresh** is issued every ≥TTL per key;
 * - the first fetch for a key propagates errors to the caller (nothing to
 *   serve stale); background refresh failures keep the stale value (strictly
 *   better than nothing for the board) and later calls retry.
 *
 * ## Policy options (deliberate per-user seams, #131 — do not flatten)
 *
 * - `swr: false` — throttle mode: past the TTL the caller **waits** for a
 *   fresh, deduplicated fetch instead of being served the stale value
 *   (the update checker must not show an old checked-at).
 * - `cacheErrors: true` — a failed fetch is cached for the TTL like a
 *   verdict: within the TTL, `get` rethrows it without re-fetching (the
 *   pi-auth probe's #100 pileup guard). Without it, errors are never cached
 *   and the next `get` retries.
 * - `onStale` — transform applied to values served stale (e.g. the pi-auth
 *   probe marks them `stale: true`).
 * - `ttlMs: 0` — no cache at all: every caller awaits a fresh, deduplicated
 *   fetch and nothing is stored.
 */
export interface TtlSwrCacheDeps<T> {
  /** Cache TTL in ms. Default 30_000; `0` disables caching. */
  ttlMs?: number;
  /** Injectable clock (ms epoch; tests). */
  now?: () => number;
  /** Serve stale values past the TTL with a background refresh. Default true. */
  swr?: boolean;
  /** Cache a failed fetch's error for the TTL (rethrown on later gets). Default false. */
  cacheErrors?: boolean;
  /** Transform applied to a value served stale (fresh hits are untouched). */
  onStale?: (value: T) => T;
}

interface SwrEntry<T> {
  /** Cached value; absent only for a failure cached under `cacheErrors`. */
  value?: T;
  /** Cached failure (only with `cacheErrors`), rethrown for the TTL. */
  failure?: { error: unknown };
  /** Completion time of the fetch that produced the entry (ms epoch). */
  fetchedAt: number;
  /** Single-flight background refresh (stale-while-revalidate). */
  refreshing?: Promise<void>;
}

export class TtlSwrCache<T> {
  private readonly entries = new Map<string, SwrEntry<T>>();
  /** Shared in-flight fetches: cold misses, no-cache mode, and past-TTL throttled refreshes. */
  private readonly pending = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly swr: boolean;
  private readonly cacheErrors: boolean;
  private readonly onStale?: (value: T) => T;
  private readonly now: () => number;

  constructor(
    private readonly deps: TtlSwrCacheDeps<T> = {},
  ) {
    this.ttlMs = deps.ttlMs ?? 30_000;
    this.swr = (deps.swr ?? true) && this.ttlMs > 0;
    this.cacheErrors = deps.cacheErrors ?? false;
    this.onStale = deps.onStale;
    this.now = deps.now ?? Date.now;
  }

  /**
   * The cached value for `key`, or the result of `fetchValue`:
   *
   * - fresh (age < TTL): the cached value — 0 fetches;
   * - stale (SWR mode): the stale value immediately (through `onStale`) and
   *   at most 1 background refresh per TTL (single-flight per key);
   * - otherwise (cold, `ttlMs: 0`, throttle mode past the TTL, or a cached
   *   failure past its TTL): the caller awaits a fresh, deduplicated fetch.
   *
   * Errors propagate; with `cacheErrors` the failure itself is cached for
   * the TTL (rethrown on later calls, no re-fetch) — the #100 pileup guard.
   */
  async get(key: string, fetchValue: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      if (this.now() - entry.fetchedAt < this.ttlMs) {
        if (entry.failure !== undefined) throw entry.failure.error;
        return entry.value as T;
      }
      if (this.swr && entry.value !== undefined) {
        // Stale-while-revalidate: never block the caller on the refresh.
        if (entry.refreshing === undefined) {
          entry.refreshing = this.store(key, fetchValue)
            .then(
              () => undefined,
              () => undefined,
            )
            .finally(() => {
              entry.refreshing = undefined;
            });
        }
        const value = entry.value;
        return this.onStale === undefined ? value : this.onStale(value);
      }
    }
    return this.singleFlight(key, fetchValue);
  }

  /**
   * Fetches fresh unconditionally (no cache read), stores the result, and
   * returns it — for explicit refreshes (the update checker's `?refresh=1`).
   */
  async refresh(key: string, fetchValue: () => Promise<T>): Promise<T> {
    return this.store(key, fetchValue);
  }

  /** Drops cached entries by key prefix (all, or e.g. one project's). */
  invalidate(prefix?: string): void {
    if (prefix === undefined) this.entries.clear();
    else for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }

  /** Awaits a fresh fetch, deduplicated: concurrent callers share one run. */
  private singleFlight(key: string, fetchValue: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing;
    const promise = (this.ttlMs > 0 ? this.store(key, fetchValue) : fetchValue()).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  /** Fetches, caches (with fetch completion time), and returns the value. */
  private async store(key: string, fetchValue: () => Promise<T>): Promise<T> {
    try {
      const value = await fetchValue();
      if (this.ttlMs > 0) this.entries.set(key, { value, fetchedAt: this.now() });
      return value;
    } catch (error) {
      // Cache the failure for the TTL only when there is no value to keep:
      // a stale value is strictly better than a rejection.
      const cached = this.entries.get(key);
      if (this.cacheErrors && this.ttlMs > 0 && (cached === undefined || cached.value === undefined)) {
        this.entries.set(key, { failure: { error }, fetchedAt: this.now() });
      }
      throw error;
    }
  }
}
