/**
 * Pull request operations: REST list/mapping onto the shared
 * {@link PullRequest} contract, CI (checks) status, review decision, and
 * review comments.
 */

import { z } from "zod";
import { ciStatusSchema, reviewStateSchema, pullRequestSchema, type PullRequest } from "@pideck/shared";

import type { GhClient, RepoRef } from "./gh.js";
import { graphqlNodeSchema } from "./graphql-node.js";

/** Derived from the shared schemas (shared does not export these as named types). */
type CiStatus = z.infer<typeof ciStatusSchema>;
type ReviewState = z.infer<typeof reviewStateSchema>;

// ---------------------------------------------------------------------------
// REST list + mapping
// ---------------------------------------------------------------------------

const restPullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable(),
  user: z.object({ login: z.string() }).nullable(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
  html_url: z.string().url(),
  updated_at: z.string(),
  // Issue #261: present on the REST PR payload; optional so unexpected
  // shapes degrade to cards without diff counts instead of failing.
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  // Issue #322: GitHub's mergeability verdict. `null` while GitHub computes
  // it — mapped to "not known to conflict".
  mergeable: z.boolean().nullable().optional(),
});

export interface PullRequestRecord {
  /** Shared-contract view (`ciStatus`/`reviewState` default to `"unknown"`/`"none"`). */
  pullRequest: PullRequest;
  /** Head commit SHA — feed to {@link getCiStatus}. */
  headSha: string;
}

/** Maps one REST PR payload. */
export function mapRestPull(projectId: string, raw: unknown): PullRequestRecord {
  const r = restPullSchema.parse(raw);
  const state: PullRequest["state"] = r.state === "open" ? "open" : r.merged_at !== null ? "merged" : "closed";
  const pullRequest = pullRequestSchema.parse({
    projectId,
    number: r.number,
    title: r.title,
    state,
    ciStatus: "unknown",
    reviewState: "none",
    headBranch: r.head.ref,
    baseBranch: r.base.ref,
    author: r.user?.login ?? "unknown",
    url: r.html_url,
    updatedAt: r.updated_at,
    ...(r.additions !== undefined && r.deletions !== undefined
      ? { additions: r.additions, deletions: r.deletions }
      : {}),
    ...(r.mergeable !== undefined && r.mergeable !== null ? { mergeConflicts: !r.mergeable } : {}),
  });
  return { pullRequest, headSha: r.head.sha };
}

/** Lists repository pull requests via REST (all states by default). */
export async function listPullRequests(gh: GhClient, projectId: string, repo: RepoRef, state: "open" | "closed" | "all" = "all"): Promise<PullRequestRecord[]> {
  const raw = await gh.apiList<unknown>(`/repos/${repo.owner}/${repo.repo}/pulls?state=${state}&sort=updated&direction=desc`);
  return raw.map((r) => mapRestPull(projectId, r));
}

// ---------------------------------------------------------------------------
// Batched listing: one GraphQL call for open PRs + CI/review meta (issue #40)
// ---------------------------------------------------------------------------

const graphqlPullsQuery = `
query($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number
        title
        url
        updatedAt
        author { login }
        headRefName
        baseRefName
        headRefOid
        reviewDecision
        mergeable
        additions
        deletions
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup { state }
            }
          }
        }
      }
    }
  }
}
` as const;

const graphqlPullsSchema = z.object({
  repository: z.object({
    pullRequests: z.object({
      nodes: z.array(
        z.object({
          ...graphqlNodeSchema.shape,
          author: z.object({ login: z.string() }).nullable(),
          headRefName: z.string(),
          baseRefName: z.string(),
          headRefOid: z.string(),
          reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
          // Optional so unexpected shapes degrade (issue #261 pattern) — the
          // mapping treats an absent verdict as "not known to conflict".
          mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]).nullable().optional(),
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative(),
          commits: z.object({
            nodes: z.array(
              z.object({
                commit: z.object({
                  statusCheckRollup: z.object({ state: z.enum(["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"]) }).nullable(),
                }),
              }),
            ),
          }),
        }),
      ),
    }),
  }),
});

function mapRollupState(state: string | null): CiStatus {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "unknown";
  }
}

function mapReviewDecision(decision: string | null): ReviewState {
  if (decision === "APPROVED") return "approved";
  if (decision === "CHANGES_REQUESTED") return "changes_requested";
  return "none";
}

export interface BatchedPullListOptions {
  /** Maximum open PRs to return (top N by `updatedAt`). Default 100. */
  first?: number;
}

/**
 * Lists the most recently updated open PRs with CI status and review decision
 * already resolved — in a **single** GraphQL call (issue #40).
 *
 * Replaces the O(PR) enrichment loop ({@link listPullRequestsWithMeta}) for
 * the daemon API's pulls listing path (issue #40) and for the PR watcher's
 * poll loop (issue #42): the old flow made 1 REST list call + 2
 * calls per PR (check-runs + reviews) — 201 calls per kanban refresh at 100
 * open PRs — while this flow costs **1 GraphQL call regardless of PR count**
 * (up to `first`, default 100; no pagination). The API layer additionally
 * caches the result with a TTL (see `apps/daemon/src/api/pull-listing.ts`).
 *
 * CI/review mapping is coarser than the per-PR REST path: the rollup commit
 * status has no `running` distinction (maps to `"pending"`), and a PR with no
 * checks/`statusCheckRollup` maps to `"unknown"`/`"none"`.
 */
export async function listOpenPullRequestsBatched(gh: GhClient, projectId: string, repo: RepoRef, options: BatchedPullListOptions = {}): Promise<PullRequest[]> {
  const first = options.first ?? 100;
  const data = await gh.graphql<unknown>(graphqlPullsQuery, { owner: repo.owner, name: repo.repo, first });
  const parsed = graphqlPullsSchema.parse(data);
  return parsed.repository.pullRequests.nodes.map((node) =>
    pullRequestSchema.parse({
      projectId,
      number: node.number,
      title: node.title,
      state: "open",
      ciStatus: mapRollupState(node.commits.nodes.at(-1)?.commit.statusCheckRollup?.state ?? null),
      reviewState: mapReviewDecision(node.reviewDecision),
      headBranch: node.headRefName,
      baseBranch: node.baseRefName,
      author: node.author?.login ?? "unknown",
      url: node.url,
      updatedAt: node.updatedAt,
      additions: node.additions,
      deletions: node.deletions,
      ...(node.mergeable === "CONFLICTING" ? { mergeConflicts: true } : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// CI status (checks + legacy combined status fallback)
// ---------------------------------------------------------------------------

const checkRunsSchema = z.object({
  total_count: z.number().int(),
  check_runs: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["queued", "in_progress", "completed"]),
      conclusion: z
        .enum(["success", "failure", "neutral", "cancelled", "timed_out", "action_required", "stale", "startup_failure", "skipped"])
        .nullable(),
    }),
  ),
});

const combinedStatusSchema = z.object({
  state: z.enum(["error", "failure", "pending", "success"]),
  total_count: z.number().int(),
});

const combinedStatusContextsSchema = z.object({
  statuses: z.array(
    z.object({
      context: z.string(),
      state: z.enum(["error", "failure", "pending", "success"]),
    }),
  ),
});

const BAD_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

/**
 * Combined CI status of a commit: check runs first; when the commit has no
 * check runs, falls back to the legacy combined commit status; with neither,
 * `"unknown"`. Maps onto the shared {@link CiStatus} enum.
 */
export async function getCiStatus(gh: GhClient, repo: RepoRef, headSha: string): Promise<CiStatus> {
  const runs = checkRunsSchema.parse(await gh.apiJson(`/repos/${repo.owner}/${repo.repo}/commits/${headSha}/check-runs`));
  if (runs.check_runs.length === 0) {
    const status = combinedStatusSchema.parse(await gh.apiJson(`/repos/${repo.owner}/${repo.repo}/commits/${headSha}/status`));
    if (status.total_count === 0) return "unknown";
    return status.state === "success" ? "success" : status.state === "pending" ? "pending" : "failure";
  }
  let sawPending = false;
  let sawRunning = false;
  for (const run of runs.check_runs) {
    if (run.status === "completed") {
      if (run.conclusion !== null && BAD_CONCLUSIONS.has(run.conclusion)) return "failure";
    } else if (run.status === "in_progress") {
      sawRunning = true;
    } else {
      sawPending = true;
    }
  }
  if (sawRunning) return "running";
  if (sawPending) return "pending";
  return "success";
}

/**
 * Names of the failing checks on a commit (issue #322): completed check runs
 * with a bad conclusion; when the commit has no check runs, the legacy
 * combined-status contexts in a failing state. Feeds the autoFixCi prompt so
 * the worker gets actionable targets instead of a bare "CI is failing".
 */
export async function getFailingChecks(gh: GhClient, repo: RepoRef, headSha: string): Promise<string[]> {
  const runs = checkRunsSchema.parse(await gh.apiJson(`/repos/${repo.owner}/${repo.repo}/commits/${headSha}/check-runs`));
  if (runs.check_runs.length === 0) {
    const status = combinedStatusContextsSchema.parse(await gh.apiJson(`/repos/${repo.owner}/${repo.repo}/commits/${headSha}/status`));
    return status.statuses.filter((s) => s.state === "failure" || s.state === "error").map((s) => s.context);
  }
  return runs.check_runs
    .filter((run) => run.status === "completed" && run.conclusion !== null && BAD_CONCLUSIONS.has(run.conclusion))
    .map((run) => run.name);
}

// ---------------------------------------------------------------------------
// Review decision
// ---------------------------------------------------------------------------

const reviewsSchema = z.array(
  z.object({
    user: z.object({ login: z.string() }).nullable(),
    state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
    submitted_at: z.string().nullable(),
  }),
);

/**
 * Latest review decision on a PR, mapped onto the shared {@link ReviewState}
 * enum. Computed from the reviews list with latest-review-per-user semantics
 * (mirrors GitHub's reviewDecision): any user's latest decisive review being
 * CHANGES_REQUESTED wins, then APPROVED, otherwise `"none"`.
 */
export async function getReviewState(gh: GhClient, repo: RepoRef, prNumber: number): Promise<ReviewState> {
  const reviews = reviewsSchema.parse(await gh.apiJson(`/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/reviews`));
  // Reviews come in submission order; keep the latest decisive one per user.
  const latest = new Map<string, string>();
  for (const review of reviews) {
    if (review.user === null) continue;
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    latest.set(review.user.login, review.state);
  }
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (states.includes("APPROVED")) return "approved";
  return "none";
}

// ---------------------------------------------------------------------------
// Review comments
// ---------------------------------------------------------------------------

const reviewCommentsSchema = z.array(
  z.object({
    id: z.number().int(),
    user: z.object({ login: z.string() }).nullable(),
    body: z.string(),
    path: z.string(),
    line: z.number().int().nullable(),
    in_reply_to_id: z.number().int().nullable(),
    html_url: z.string().url(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
);

/** A review comment (inline code comment) on a PR. */
export interface PRReviewComment {
  id: number;
  author: string | null;
  body: string;
  path: string;
  line: number | null;
  /** Comment this one replies to, if any. */
  inReplyToId: number | null;
  url: string;
  createdAt: string;
  updatedAt: string;
}

/** Fetches the inline review comments of a PR (all pages). */
export async function fetchReviewComments(gh: GhClient, repo: RepoRef, prNumber: number): Promise<PRReviewComment[]> {
  const raw = await gh.apiList<unknown>(`/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/comments`);
  return reviewCommentsSchema.parse(raw).map((c) => ({
    id: c.id,
    author: c.user?.login ?? null,
    body: c.body,
    path: c.path,
    line: c.line,
    inReplyToId: c.in_reply_to_id,
    url: c.html_url,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  }));
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

/** Fills in CI status and review decision for one PR (two API calls). */
export async function enrichPullRequest(gh: GhClient, repo: RepoRef, record: PullRequestRecord): Promise<PullRequest> {
  const [ciStatus, reviewState] = await Promise.all([
    getCiStatus(gh, repo, record.headSha),
    getReviewState(gh, repo, record.pullRequest.number),
  ]);
  return { ...record.pullRequest, ciStatus: ciStatusSchema.parse(ciStatus), reviewState: reviewStateSchema.parse(reviewState) };
}

/** Lists open PRs with CI status and review decision resolved (parallel). */
export async function listPullRequestsWithMeta(gh: GhClient, projectId: string, repo: RepoRef): Promise<PullRequest[]> {
  const records = await listPullRequests(gh, projectId, repo, "open");
  return Promise.all(records.map((r) => enrichPullRequest(gh, repo, r)));
}
