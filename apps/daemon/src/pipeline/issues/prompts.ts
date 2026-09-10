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

/** Collapses whitespace so a prompt is always a single pane-safe line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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
      "\`Closes #" + issue.number + "\` in the PR body (e.g. \`pideck report-pr <pr>\` to report it): the platform " +
      "unblocks dependent tickets when the PR merges, and that only works with the closing keyword.",
  ];
  return parts.map(oneLine).join(" ");
}
