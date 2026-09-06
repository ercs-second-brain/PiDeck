/**
 * Pull request operations: REST list/mapping onto the shared
 * {@link PullRequest} contract, CI (checks) status, review decision, and
 * review comments.
 */

import { z } from "zod";
import { ciStatusSchema, reviewStateSchema, pullRequestSchema, type PullRequest } from "@agentskiss/shared";

/** Derived from the shared schemas (shared does not export these as named types). */
type CiStatus = z.infer<typeof ciStatusSchema>;
type ReviewState = z.infer<typeof reviewStateSchema>;

import type { GhClient, RepoRef } from "./gh.js";

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
  });
  return { pullRequest, headSha: r.head.sha };
}

/** Lists repository pull requests via REST (all states by default). */
export async function listPullRequests(gh: GhClient, projectId: string, repo: RepoRef, state: "open" | "closed" | "all" = "all"): Promise<PullRequestRecord[]> {
  const raw = await gh.apiList<unknown>(`/repos/${repo.owner}/${repo.repo}/pulls?state=${state}&sort=updated&direction=desc`);
  return raw.map((r) => mapRestPull(projectId, r));
}

// ---------------------------------------------------------------------------
// CI status (checks + legacy combined status fallback)
// ---------------------------------------------------------------------------

const checkRunsSchema = z.object({
  total_count: z.number().int(),
  check_runs: z.array(
    z.object({
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

export interface PullRequestMeta {
  ciStatus: CiStatus;
  reviewState: ReviewState;
}

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
