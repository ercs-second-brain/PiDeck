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

import type { PullRequest } from "@agentskiss/shared";

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
}

/** Builds the prompt sent to a worker when its PR's CI is failing. */
export function buildCiFixPrompt(pr: PullRequest, options: CiFixPromptOptions): string {
  const parts = [
    `[agentskiss] CI is failing on your PR #${pr.number} "${oneLine(pr.title)}" (${pr.url}).`,
    `Fix attempt ${options.attempt} of ${options.maxAttempts}: inspect the failing checks ` +
      `(e.g. \`gh pr checks ${pr.number}\` or \`gh run view\`), fix the failures, commit, and push ` +
      `to the PR branch \`${pr.headBranch}\`.`,
  ];
  if (options.comments !== undefined && options.comments.length > 0) {
    parts.push(commentSummary(options.comments));
  }
  parts.push("Do not open a new PR. When done, reply with a short summary of what you fixed.");
  return parts.map(oneLine).join(" ");
}

/** Builds the prompt sent to a worker when new review comments arrive on a green PR. */
export function buildReviewCommentsPrompt(pr: PullRequest, comments: PRReviewComment[]): string {
  const parts = [
    `[agentskiss] ${comments.length} new review comment(s) on your PR #${pr.number} ` +
      `"${oneLine(pr.title)}" (${pr.url}):`,
    commentSummary(comments),
    `Address each comment, commit, and push a follow-up commit to the PR branch \`${pr.headBranch}\`; ` +
      `mark threads you resolved as resolved if the platform supports it.`,
    "Do not open a new PR. When done, reply with a short summary of what you changed.",
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
