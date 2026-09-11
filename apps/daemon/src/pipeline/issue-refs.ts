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
 * GitHub's closing keywords (issue #441): only these body mentions claim
 * ownership. A bare `#N` in the body — "Depends on #440", "related to #12" —
 * is not evidence the PR belongs to the worker on issue #N; with parallel
 * workers such cross-references made the first-match sweep associate a PR
 * to a worker that is merely referenced (the reviewer then nested under
 * the wrong owner).
 */
const CLOSING_KEYWORD_REFS = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

function closingKeywordRefs(body: string): Set<number> {
  const refs = new Set<number>();
  for (const match of body.matchAll(CLOSING_KEYWORD_REFS)) refs.add(Number(match[1]));
  return refs;
}

/**
 * First unassociated, non-terminal worker whose issue is referenced in
 * `refs` — the candidate scan for one evidence tier.
 */
function ownerForRefs(workers: Worker[], refs: Set<number>): Worker | undefined {
  if (refs.size === 0) return undefined;
  return workers.find(
    (worker) =>
      worker.prNumber === null && worker.issueNumber !== 0 && refs.has(worker.issueNumber) && PR_OWNABLE_STATUSES.has(worker.status),
  );
}

/**
 * Associates a PR with its owning worker: an unassociated, non-terminal
 * worker whose issue the PR references is recorded as the PR owner
 * (`setWorkerPr`) — the PR loop's tracker resolves ownership from the
 * registry. Only ever fills workers whose `prNumber` is still null.
 *
 * Evidence is tiered (issue #441): a title/head-branch reference — the PR
 * headline names its own issue — outranks the body, and the body claims
 * only through GitHub's closing keywords (`Closes #N`), the #439-mandated
 * self-report. Bare body mentions ("Depends on #N") never claim: with
 * parallel workers on related issues they picked the wrong owner, and the
 * auto reviewer then nested under that wrong worker.
 */
export function associateWorkerPr(
  tracker: PRTracker,
  workers: Worker[],
  setWorkerPr: (workerId: string, prNumber: number) => void,
  pr: PullRequest,
): void {
  if (tracker.get(pr.projectId, pr.number) !== undefined) return;
  if (workers.some((worker) => worker.prNumber === pr.number)) return;
  const owner =
    ownerForRefs(workers, referencedIssueNumbers(`${pr.title} ${pr.headBranch}`)) ??
    (pr.body === undefined ? undefined : ownerForRefs(workers, closingKeywordRefs(pr.body)));
  if (owner !== undefined) setWorkerPr(owner.id, pr.number);
}
