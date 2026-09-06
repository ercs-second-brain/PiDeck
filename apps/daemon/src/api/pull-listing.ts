/**
 * Cached batched PR listing for the daemon API (issue #40).
 *
 * ## Rate-limit budget
 *
 * The GitHub token is shared by everything (watchers, pipelines, this API), so
 * the API layer must be frugal:
 *
 * - **Old behavior** (per-PR enrichment in `listProjectPullRequests`): one
 *   REST list call + 2 calls per PR (check-runs + reviews) → **201 calls per
 *   kanban refresh at 100 open PRs** (more when the legacy commit-status
 *   fallback kicks in). Observed exhausting the shared token during #13's
 *   e2e run against a real repo.
 * - **New behavior**: the listing itself is a single GraphQL call
 *   (`listOpenPullRequestsBatched` — up to the top 100 open PRs by recency,
 *   CI status and review decision included), and this service caches it per
 *   project with a 30s TTL and **stale-while-revalidate**:
 *   - cache fresh (age < TTL): **0 API calls**;
 *   - cache stale: the stale value is served immediately and at most **1
 *     background refresh call** is issued every ≥TTL per project.
 *
 *   Worst case for a repo with 100+ open PRs: **1 GraphQL call per 30s per
 *   project (~120/h)**, down from 201+ calls on every poll — a ≥97% reduction
 *   per kanban refresh.
 */

import type { PullRequest } from "@agentskiss/shared";

import { listOpenPullRequestsBatched, parseRepoUrl, type GhClient } from "../github/index.js";

export interface PullListingServiceDeps {
  /** GhClient factory keyed by repo URL; overridable in tests. */
  gh: (repoUrl: string) => GhClient;
  /** Cache TTL in ms. Default 30_000. */
  ttlMs?: number;
  /** Max open PRs per listing (top N by recency). Default 100. */
  first?: number;
  /** Injectable clock (ms epoch; tests). */
  now?: () => number;
}

interface CacheEntry {
  value: PullRequest[];
  /** Completion time of the fetch that produced `value` (ms epoch). */
  fetchedAt: number;
  /** Single-flight background refresh (stale-while-revalidate). */
  refreshing?: Promise<void>;
}

export class PullListingService {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly first: number;
  private readonly now: () => number;

  constructor(private readonly deps: PullListingServiceDeps) {
    this.ttlMs = deps.ttlMs ?? 30_000;
    this.first = deps.first ?? 100;
    this.now = deps.now ?? Date.now;
  }

  /**
   * The project's open PRs with CI/review metadata, batched + cached. Serves
   * from the TTL cache when fresh; when stale, returns the cached value
   * immediately and refreshes in the background (single-flight — at most one
   * in-flight refresh per project). The first call for a project fetches and
   * propagates errors to the caller; later background refresh failures keep
   * the stale value (it is strictly better than nothing for the board).
   */
  async list(projectId: string, repoUrl: string): Promise<PullRequest[]> {
    const key = cacheKey(projectId, repoUrl);
    const entry = this.entries.get(key);
    if (entry === undefined) return this.refresh(key, projectId, repoUrl);
    if (this.now() - entry.fetchedAt >= this.ttlMs && entry.refreshing === undefined) {
      entry.refreshing = this.refresh(key, projectId, repoUrl)
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

  /** Drops cached entries (all, or one project's) — e.g. for tests. */
  invalidate(projectId?: string): void {
    if (projectId === undefined) this.entries.clear();
    else for (const key of this.entries.keys()) if (key.startsWith(`${projectId}\n`)) this.entries.delete(key);
  }

  /** Fetches the batched listing and stores it as the fresh cache value. */
  private async refresh(key: string, projectId: string, repoUrl: string): Promise<PullRequest[]> {
    const gh = this.deps.gh(repoUrl);
    const value = await listOpenPullRequestsBatched(gh, projectId, parseRepoUrl(repoUrl), { first: this.first });
    this.entries.set(key, { value, fetchedAt: this.now() });
    return value;
  }
}

/** Cache key: project + repo (a repoUrl change must not be served stale values of the old repo). */
function cacheKey(projectId: string, repoUrl: string): string {
  return `${projectId}\n${repoUrl}`;
}
