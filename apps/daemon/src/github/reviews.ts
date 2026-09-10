/**
 * PR review retrieval: the reviews list (one API call, submission order),
 * the derived review decision, and — issue #407 — the latest review
 * submission of any state. The submission watermark in the PR tracker keys
 * the deterministic worker trigger; #408's PR lifecycle builds on the same
 * signal.
 */

import { z } from "zod";

import type { GhClient, RepoRef } from "./gh.js";

const reviewsSchema = z.array(
  z.object({
    user: z.object({ login: z.string() }).nullable(),
    state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
    submitted_at: z.string().nullable(),
  }),
);

/** Fetches the PR's reviews list (one API call, submission order). */
export async function fetchReviews(gh: GhClient, repo: RepoRef, prNumber: number): Promise<z.infer<typeof reviewsSchema>> {
  return reviewsSchema.parse(await gh.apiJson(`/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/reviews`));
}

/** Latest decisive review per user (mirrors GitHub's reviewDecision). */
export function reviewDecisionFrom(reviews: z.infer<typeof reviewsSchema>): "none" | "approved" | "changes_requested" {
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

/**
 * Latest review decision on a PR, mapped onto the shared ReviewState enum
 * (minus `"pending"`, which is never derived here). Computed from the
 * reviews list with latest-review-per-user semantics (mirrors GitHub's
 * reviewDecision): any user's latest decisive review being
 * CHANGES_REQUESTED wins, then APPROVED, otherwise `"none"`.
 */
export async function getReviewState(gh: GhClient, repo: RepoRef, prNumber: number): Promise<"none" | "approved" | "changes_requested"> {
  return reviewDecisionFrom(await fetchReviews(gh, repo, prNumber));
}

/**
 * A review submission on a PR (issue #407): any recorded review event with
 * a submission time. The tracker's review watermark keys the deterministic
 * worker trigger — #408's lifecycle builds on the same signal.
 */
export interface ReviewSubmission {
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  author: string | null;
  submittedAt: string;
}

const SUBMISSION_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]) as Set<string>;

function isSubmissionState(state: string): state is ReviewSubmission["state"] {
  return SUBMISSION_STATES.has(state);
}

/** The most recent review submission of any actionable state (or `null`). */
export function latestSubmissionFrom(reviews: z.infer<typeof reviewsSchema>): ReviewSubmission | null {
  for (let i = reviews.length - 1; i >= 0; i--) {
    const review = reviews[i]!;
    if (review.submitted_at === null || !isSubmissionState(review.state)) continue;
    return { state: review.state, author: review.user?.login ?? null, submittedAt: review.submitted_at };
  }
  return null;
}

/** Latest review submission of any state (a COMMENTED review counts, #407). */
export async function getLatestReview(gh: GhClient, repo: RepoRef, prNumber: number): Promise<ReviewSubmission | null> {
  return latestSubmissionFrom(await fetchReviews(gh, repo, prNumber));
}