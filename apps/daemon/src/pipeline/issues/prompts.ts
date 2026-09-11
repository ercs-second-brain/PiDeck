/**
 * Initial prompt for issue-backed auto-spawns (issue #266).
 *
 * The issue-spawn pipeline used to launch a worker with no prompt at all —
 * the worker booted into an idle pi pane and sat there until a human typed
 * into it. Every auto-spawned worker now receives the assigned issue's
 * context as its initial prompt, delivered through the same prompt-gate
 * parity the manual spawn and review-agent paths follow (issue #56).
 *
 * Like the PR-lifecycle prompts (`../prs/prompts.ts`), the prompt is a
 * single pane-safe line following the worker prompt conventions from
 * `agent/prompts/worker.md`: it is typed into the worker's interactive
 * pane followed by Enter — embedded newlines would submit early.
 */

import type { Issue } from "@pideck/shared";

import { oneLine } from "../prompt-line.js";

/**
 * Builds the stall re-prompt (issue #467): typed into a stalled issue
 * worker's pane by the deterministic sweep — the worker's turn silently
 * ended (no PR, no activity for the whole idle window) and nothing else
 * re-prompts it. The worker's session already carries the issue context
 * (the spawn prompt), so the nudge stays short: report or continue, and
 * the bounded-loop notice.
 */
export function buildStallRepromptPrompt(issueNumber: number, attempt: number, maxAttempts: number): string {
  const parts = [
    `[pideck] Stall check: your last turn on issue #${issueNumber} ended without a PR and without platform-visible progress.`,
    `If you are still working, reply with a one-line status and keep going. ` +
      `If your turn finished early, continue the task: implement the issue (\`gh issue view ${issueNumber}\`) ` +
      "and verify the result.",
    `Re-prompt ${attempt} of ${maxAttempts}: when the change is ready, open (or update) the PR that links ` +
      "the issue with a closing keyword — \`Closes #" + issueNumber + "\` in the PR body. " +
      "After the final re-prompt goes unanswered the worker is marked failed.",
  ];
  return parts.map(oneLine).join(" ");
}

/**
 * Builds the initial prompt for the worker auto-spawned for an issue:
 * the issue's number, title, URL, and assignment as the task context, plus
 * the task-source workflow the worker prompt already establishes (read the
 * issue, implement it, verify, open a PR linking the issue).
 */
export function buildIssueSpawnPrompt(issue: Issue): string {
  const parts = [
    `[pideck] You are the worker for issue #${issue.number} "${oneLine(issue.title)}" (${issue.url}).`,
    issue.assignee === null
      ? "You own this issue end-to-end."
      : `You own this issue end-to-end (assigned to ${issue.assignee}).`,
    `Read the issue (e.g. \`gh issue view ${issue.number}\`) for the full task context, then implement ` +
      "it in your workspace: plan, edit code, run the project's checks, and fix what fails.",
    `When the change is ready, open a PR that links the issue with a closing keyword — put ` +
      "\`Closes #" + issue.number + "\` in the PR body: the platform unblocks " +
      "dependent tickets when the PR merges (that only works with the closing keyword), and the daemon " +
      "claims the PR for you deterministically by those references — there is no report step.",
  ];
  return parts.map(oneLine).join(" ");
}
