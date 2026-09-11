/**
 * Worker↔PR association by issue reference (issue #46 wiring, extracted;
 * fully deterministic since issue #439).
 *
 * Workers don't report PRs — there is no self-report path. The wiring
 * performs the association when the PR watcher reports a PR: if the PR's
 * title, head branch, or body references the issue a non-terminal,
 * unassociated worker is working on (`#46`, `issue 46`, `issue-46`, or the
 * prompt-mandated `Closes #46` closing keyword in the body), the worker is
 * recorded as the PR owner (`SessionManager.setWorkerPr`). This is the
 * only claiming path: deterministic daemon code keyed on platform truth.
 */

import type { PullRequest, Worker, WorkerStatus } from "@pideck/shared";

import type { PRTracker } from "./prs/tracker.js";

/** Worker statuses that may own a PR (mirrors the active-spawn statuses). */
const PR_OWNABLE_STATUSES = new Set<WorkerStatus>([
  "spawning",
  "running",
  "awaiting_ci",
  "fixing_ci",
  "addressing_review",
]);

/** Issue numbers referenced in free text: `#46`, `issue 46`, `issue-46`, `Issue_46`. */
function referencedIssueNumbers(text: string): Set<number> {
  const refs = new Set<number>();
  for (const match of text.matchAll(/#(\d+)\b/g)) refs.add(Number(match[1]));
  for (const match of text.matchAll(/\bissue[-_ ]?(\d+)\b/gi)) refs.add(Number(match[1]));
  return refs;
}

/**
 * Associates a PR with its owning worker: if the PR's title, head branch,
 * or body references the issue an unassociated, non-terminal worker is
 * working on, record the worker as the PR owner (`setWorkerPr`) — the PR
 * loop's tracker resolves ownership from the registry. Only ever fills
 * workers whose `prNumber` is still null.
 */
export function associateWorkerPr(
  tracker: PRTracker,
  workers: Worker[],
  setWorkerPr: (workerId: string, prNumber: number) => void,
  pr: PullRequest,
): void {
  if (tracker.get(pr.projectId, pr.number) !== undefined) return;
  if (workers.some((worker) => worker.prNumber === pr.number)) return;
  const refs = referencedIssueNumbers(`${pr.title} ${pr.headBranch} ${pr.body ?? ""}`);
  if (refs.size === 0) return;
  const owner = workers.find(
    (worker) =>
      worker.prNumber === null && worker.issueNumber !== 0 && refs.has(worker.issueNumber) && PR_OWNABLE_STATUSES.has(worker.status),
  );
  if (owner !== undefined) setWorkerPr(owner.id, pr.number);
}
