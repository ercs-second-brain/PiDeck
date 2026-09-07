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
import { TtlSwrCache } from "./swr-cache.js";

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

export class PullListingService {
  private readonly cache: TtlSwrCache<PullRequest[]>;
  private readonly first: number;

  constructor(private readonly deps: PullListingServiceDeps) {
    this.first = deps.first ?? 100;
    this.cache = new TtlSwrCache<PullRequest[]>({ ttlMs: deps.ttlMs, now: deps.now });
  }

  /**
   * The project's open PRs with CI/review metadata, batched + cached (issue
   * #40): fresh → 0 API calls; stale → serve immediately + at most one
   * background refresh per project (single-flight). The first call for a
   * project fetches and propagates errors; background refresh failures keep
   * the stale value (strictly better than nothing for the board).
   */
  async list(projectId: string, repoUrl: string): Promise<PullRequest[]> {
    return this.cache.get(cacheKey(projectId, repoUrl), () => this.fetchListing(projectId, repoUrl));
  }

  /** Drops cached entries (all, or one project's) — e.g. for tests. */
  invalidate(projectId?: string): void {
    this.cache.invalidate(projectId === undefined ? undefined : `${projectId}\n`);
  }

  /** Fetches the batched listing. */
  private async fetchListing(projectId: string, repoUrl: string): Promise<PullRequest[]> {
    const gh = this.deps.gh(repoUrl);
    return listOpenPullRequestsBatched(gh, projectId, parseRepoUrl(repoUrl), { first: this.first });
  }
}

/** Cache key: project + repo (a repoUrl change must not be served stale values of the old repo). */
function cacheKey(projectId: string, repoUrl: string): string {
  return `${projectId}\n${repoUrl}`;
}
