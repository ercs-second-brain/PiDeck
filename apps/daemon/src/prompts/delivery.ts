export interface SpawnWorkerInput {
  number: number;
  title: string;
  url: string;
  branch: string;
}

export interface CiRedInput {
  failingChecks: string[];
  attempt: number;
  maxAttempts: number;
}

export interface ReviewChangesInput {
  prNumber: number;
}

export interface PrConflictInput {
  prNumber: number;
}

export interface IssueCommentInput {
  issueNumber: number;
  commentUrl: string;
}

export interface SpawnReviewerInput {
  prNumber: number;
  repo: string;
}

export interface ReReviewInput {
  prNumber: number;
}

export interface ApprovedGreenInput {
  prNumber: number;
  issueNumber: number;
}

export interface BlockerInput {
  issueNumber: number;
  commentUrl: string;
}

export interface StalledInput {
  issueNumber: number;
  stallMinutes: number;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function spawnWorker(issue: SpawnWorkerInput): string {
  return singleLine(
    `Worker session for issue #${issue.number} "${issue.title}" — work on branch ${issue.branch}, ` +
      `open the PR with pideck pr open (it adds "Closes #${issue.number}") and give it a real body ` +
      `— a short "## What" summary of the change, never just Closes. ${issue.url}`,
  );
}

export function ciRed(input: CiRedInput): string {
  return singleLine(
    `CI failed: ${input.failingChecks.join(", ")} (fix attempt ${input.attempt} of ${input.maxAttempts}). ` +
      `Read the failing runs on GitHub, fix, and push.`,
  );
}

export function ciRedExhausted(input: CiRedInput): string {
  return singleLine(
    `CI failed: ${input.failingChecks.join(", ")} — fix attempts exhausted after ${input.maxAttempts}. ` +
      `Post your status on the issue with pideck blocked and go idle.`,
  );
}

export function prConflict(input: PrConflictInput): string {
  return singleLine(
    `PR #${input.prNumber} conflicts with main — rebase the branch onto main, resolve the conflicts, and push.`,
  );
}

export function reviewChanges(input: ReviewChangesInput): string {
  return singleLine(
    `New review activity on PR #${input.prNumber} — read the review on GitHub, reply in the threads ` +
      `with pideck reply, and push fixes.`,
  );
}

export function issueComment(input: IssueCommentInput): string {
  return singleLine(`New comment on issue #${input.issueNumber} — ${input.commentUrl}`);
}

export function spawnReviewer(input: SpawnReviewerInput): string {
  return singleLine(
    `Reviewer session for PR #${input.prNumber} in ${input.repo} — read the diff and the linked issue, ` +
      `then file exactly one review with pideck review: approve or request changes.`,
  );
}

export function reReview(input: ReReviewInput): string {
  return singleLine(
    `New head on PR #${input.prNumber} — re-review and file your next single review with pideck review.`,
  );
}

export function approvedGreen(input: ApprovedGreenInput): string {
  return singleLine(
    `PR #${input.prNumber} for issue #${input.issueNumber} is approved and green — alignment check.`,
  );
}

export function blocker(input: BlockerInput): string {
  return singleLine(
    `A worker is blocked on issue #${input.issueNumber} — see the comment: ${input.commentUrl}`,
  );
}

export function stalled(input: StalledInput): string {
  return singleLine(
    `Worker for issue #${input.issueNumber} has been silent for ${input.stallMinutes} minutes — check GitHub, then steer or stop it.`,
  );
}