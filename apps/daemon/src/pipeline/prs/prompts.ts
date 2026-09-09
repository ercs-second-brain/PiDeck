/**
 * Worker prompts for the PR lifecycle loop (issue #11).
 *
 * Prompts are delivered to the owning worker's pi session via tmux
 * sendKeys and follow the worker prompt conventions from
 * `agent/prompts/worker.md`: the worker already owns CI fixing and review
 * addressing for its PR, so prompts are direct task instructions, kept to
 * a single line (they are typed into an interactive pane followed by
 * Enter — embedded newlines would submit early).
 */

import type { PullRequest } from "@pideck/shared";

import type { PRReviewComment } from "../../github/pulls.js";

/** Collapses whitespace so a prompt is always a single pane-safe line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface CiFixPromptOptions {
  /** 1-based fix attempt number for this PR (for the bounded-loop notice). */
  attempt: number;
  /** Max fix attempts before the pipeline stops driving the PR. */
  maxAttempts: number;
  /** Review comments to address in the same push (delivered together with the fix). */
  comments?: PRReviewComment[];
  /**
   * Names of the failing checks on the PR head (issue #322) — fetched by the
   * pipeline so the worker gets actionable targets instead of having to
   * discover them. Absent when the lookup failed (the prompt still points at
   * the generic inspection commands).
   */
  failingChecks?: string[];
}

/** Builds the prompt sent to a worker when its PR's CI is failing. */
export function buildCiFixPrompt(pr: PullRequest, options: CiFixPromptOptions): string {
  const parts = [
    `[pideck] CI is failing on your PR #${pr.number} "${oneLine(pr.title)}" (${pr.url}).`,
  ];
  if (options.failingChecks !== undefined && options.failingChecks.length > 0) {
    parts.push(
      `Failing checks: ${options.failingChecks.map(oneLine).join(", ")} — pull the logs with \`gh run view --log-failed\` (or \`gh pr checks ${pr.number}\`).`,
    );
  } else {
    parts.push(`Identify the failing checks first (\`gh pr checks ${pr.number}\` or \`gh run view\`).`);
  }
  parts.push(
    `Fix attempt ${options.attempt} of ${options.maxAttempts}: fix the failures, commit, and push ` +
      `to the PR branch \`${pr.headBranch}\`.`,
  );
  if (options.comments !== undefined && options.comments.length > 0) {
    parts.push(commentSummary(options.comments));
  }
  parts.push("Do not open a new PR. When done, reply with a short summary of what you fixed.");
  return parts.map(oneLine).join(" ");
}

/** Builds the prompt sent to a worker when new review comments arrive on a green PR. */
export function buildReviewCommentsPrompt(pr: PullRequest, comments: PRReviewComment[]): string {
  const parts = [
    `[pideck] ${comments.length} new review comment(s) on your PR #${pr.number} ` +
      `"${oneLine(pr.title)}" (${pr.url}):`,
    commentSummary(comments),
    `Address each comment, commit, and push a follow-up commit to the PR branch \`${pr.headBranch}\`; ` +
      `mark threads you resolved as resolved if the platform supports it.`,
    "Do not open a new PR. When done, reply with a short summary of what you changed.",
  ];
  return parts.map(oneLine).join(" ");
}

export interface ReviewAgentPromptOptions {
  /** Project id for `pideck` CLI read commands (diffs, PR state). */
  projectId: string;
  /** `owner/name` of the repository the PR lives in (for `gh --repo`). */
  repo: string;
}

/**
 * Builds the initial prompt for an auto review agent (issue #107): the
 * agent reads the PR diff, reviews it, and posts a GitHub review (approve
 * or request changes) via `gh`. Single line — it is typed into an
 * interactive pi pane (see the module docblock).
 */
export function buildReviewAgentPrompt(pr: PullRequest, options: ReviewAgentPromptOptions): string {
  const parts = [
    `[pideck] You are the review agent for PR #${pr.number} "${oneLine(pr.title)}" (${pr.url}) ` +
      `in project ${options.projectId}.`,
    `Follow your review-pr skill: read the diff (\`gh pr diff ${pr.number} --repo ${options.repo}\` ` +
      `or \`pideck diff --project ${options.projectId} ${pr.number}\`) and review it for correctness, ` +
      "bugs, and maintainability.",
    `Then post your GitHub review: approve with ` +
      `\`gh pr review ${pr.number} --repo ${options.repo} --approve --body "<summary>"\` or request changes with ` +
      `\`gh pr review ${pr.number} --repo ${options.repo} --request-changes --body "<summary>"\` ` +
      "plus inline comments via the gh api reviews endpoint (see the skill).",
    "Do not push commits, do not open or close PRs. For codebase questions the diff alone cannot answer, spawn an investigator " +
      `(read-only, grounded report) with \`pideck spawn --project ${options.projectId} --kind investigator --question "<question>" --name "<label>"\` and wait for its report before posting your review. ` +
      "When done, reply with a short review summary.",
  ];
  return parts.map(oneLine).join(" ");
}

/**
 * Builds the re-review prompt sent to an existing review agent when new
 * commits land on the PR it reviews (issue #107 re-run loop).
 */
export function buildReReviewPrompt(pr: PullRequest, options: ReviewAgentPromptOptions): string {
  const parts = [
    `[pideck] New commits were pushed to PR #${pr.number} "${oneLine(pr.title)}" (${pr.url}) ` +
      `since your last review.`,
    `Re-review the updated diff (\`gh pr diff ${pr.number} --repo ${options.repo}\`) and post a fresh ` +
      `GitHub review — approve or request changes — exactly as before (review-pr skill).`,
    "Do not push commits, do not open or close PRs. Reply with a short summary when done.",
  ];
  return parts.map(oneLine).join(" ");
}

function commentSummary(comments: PRReviewComment[]): string {
  return comments
    .map((c, i) => {
      const where = c.line === null ? c.path : `${c.path}:${c.line}`;
      const author = c.author ?? "reviewer";
      return `(${i + 1}) ${author} on ${where} — "${oneLine(c.body)}"`;
    })
    .join(" | ");
}
