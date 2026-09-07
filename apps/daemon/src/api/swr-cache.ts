/**
 * TTL cache with stale-while-revalidate + single-flight background refresh,
 * shared by the daemon API's GitHub-backed listings (issues #40, #88).
 *
 * ## Request economy
 *
 * The webapp polls listings/boards; without a cache, every poll (and any
 * webapp request storm) became a GitHub API storm. The shared token is also
 * used by watchers/pipelines, so the API layer must be frugal:
 *
 * - cache fresh (age < TTL): **0 API calls**;
 * - cache stale: the stale value is served immediately and at most **1
 *   background refresh** is issued every ≥TTL per key;
 * - the first fetch for a key propagates errors to the caller (nothing to
 *   serve stale); background refresh failures keep the stale value (strictly
 *   better than nothing for the board) and later calls retry.
 */
export interface TtlSwrCacheDeps {
  /** Cache TTL in ms. Default 30_000. */
  ttlMs?: number;
  /** Injectable clock (ms epoch; tests). */
  now?: () => number;
}

interface SwrEntry<T> {
  value: T;
  /** Completion time of the fetch that produced `value` (ms epoch). */
  fetchedAt: number;
  /** Single-flight background refresh (stale-while-revalidate). */
  refreshing?: Promise<void>;
}

export class TtlSwrCache<T> {
  private readonly entries = new Map<string, SwrEntry<T>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly deps: TtlSwrCacheDeps = {},
  ) {
    this.ttlMs = deps.ttlMs ?? 30_000;
    this.now = deps.now ?? Date.now;
  }

  /**
   * The cached value for `key`, or — when nothing is cached — the result of
   * `fetchValue` (errors propagate, the failure is not cached). A stale hit
   * serves the cached value immediately and refreshes in the background
   * (single-flight per key).
   */
  async get(key: string, fetchValue: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    if (entry === undefined) return this.store(key, fetchValue);
    if (this.now() - entry.fetchedAt >= this.ttlMs && entry.refreshing === undefined) {
      entry.refreshing = this.store(key, fetchValue)
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          entry.refreshing = undefined;
        });
    }
    return entry.value;
  }

  /** Drops cached entries by key prefix (all, or e.g. one project's). */
  invalidate(prefix?: string): void {
    if (prefix === undefined) this.entries.clear();
    else for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }

  /** Fetches, caches (with fetch completion time), and returns the value. */
  private async store(key: string, fetchValue: () => Promise<T>): Promise<T> {
    const value = await fetchValue();
    this.entries.set(key, { value, fetchedAt: this.now() });
    return value;
  }
}
