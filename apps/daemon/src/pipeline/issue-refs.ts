/**
 * Worker↔PR association (issue #46 wiring, extracted; fully deterministic
 * since issue #439).
 *
 * Workers don't report PRs — there is no self-report path. The wiring
 * performs the association when the PR watcher reports a PR: the head-branch
 * namespace (`pideck/<workerId>`, issue #466) claims deterministically;
 * failing that, issue references in the title, head branch, or body
 * (`#46`, `issue 46`, `issue-46`, or the prompt-mandated `Closes #46`
 * closing keyword) claim a non-terminal, unassociated worker. Already-
 * tracked PRs are re-verified against the namespace on re-watch, so a
 * heuristic mis-association self-corrects. This is the only claiming path:
 * deterministic daemon code keyed on platform truth.
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

/**
 * Daemon workers branch as `pideck/<workerId>` (sessions/workspace.ts) —
 * the PR head branch names its owning worker exactly. The head-branch
 * namespace is the deterministic ownership key (issue #466); issue refs in
 * title/body are only fallback evidence.
 */
const WORKER_BRANCH_PREFIX = "pideck/";

/**
 * Worker whose exact head-branch namespace owns the PR — `pideck/<workerId>`.
 * Worker ids are unique and never recycled, so the suffix is matched by
 * exact equality. The worker must be ownable and either unassociated or
 * already recorded against this very PR (the re-watch verification path).
 */
function ownerForHeadBranch(workers: Worker[], headBranch: string, prNumber: number): Worker | undefined {
  if (!headBranch.startsWith(WORKER_BRANCH_PREFIX)) return undefined;
  const workerId = headBranch.slice(WORKER_BRANCH_PREFIX.length);
  return workers.find(
    (worker) =>
      worker.id === workerId && (worker.prNumber === null || worker.prNumber === prNumber) && PR_OWNABLE_STATUSES.has(worker.status),
  );
}

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
 * Association effects (issue #466): claiming records the owner; the re-watch
 * verification also clears the worker it took the PR from. Multi-PR tracking
 * (issue #470) will lift the one-prNumber-per-worker invariant.
 */
export interface WorkerPrActions {
  setWorkerPr: (workerId: string, prNumber: number) => void;
  clearWorkerPr: (workerId: string) => void;
}

/**
 * One-shot namespace verification on re-watch (issue #466): the tracked PR's
 * owner is checked against the PR's head-branch namespace. A mis-association
 * (claimed by an issue-ref heuristic before the worker's PR was registered)
 * self-corrects — the namespaced worker takes over and the previous owner's
 * `prNumber` is cleared — so reviewer nesting and loop prompts land on the
 * right pane. The check is idempotent: once `tracked.workerId` agrees with
 * the namespace, re-watching changes nothing.
 */
function verifyNamespace(
  tracker: PRTracker,
  tracked: { workerId: string; sessionId: string },
  workers: Worker[],
  actions: WorkerPrActions,
  pr: PullRequest,
): void {
  const owner = ownerForHeadBranch(workers, pr.headBranch, pr.number);
  if (owner === undefined || owner.id === tracked.workerId) return;
  const previous = workers.find((worker) => worker.id === tracked.workerId);
  actions.setWorkerPr(owner.id, pr.number);
  if (previous !== undefined) actions.clearWorkerPr(previous.id);
  tracked.workerId = owner.id;
  tracked.sessionId = owner.sessionId;
  tracker.save();
}

/**
 * Associates a PR with its owning worker — the PR loop's tracker resolves
 * ownership from the registry. Only ever fills workers whose `prNumber` is
 * still null.
 *
 * Evidence is tiered (issues #441, #466):
 *
 * 1. exact head-branch namespace (`pideck/<workerId>`) — the PR head branch
 *    names its owning worker deterministically;
 * 2. a title/head-branch issue reference — the PR headline names its own
 *    issue;
 * 3. GitHub's closing keywords in the body (`Closes #N`) — the #439-mandated
 *    self-report. Bare body mentions ("Depends on #N") never claim: with
 *    parallel workers on related issues they picked the wrong owner, and
 *    the auto reviewer then nested under that wrong worker.
 *
 * Once a PR is tracked, a later re-watch runs the namespace verification
 * (issue #466) so a heuristic mis-association self-corrects; heuristic
 * claiming itself stays first-match only at claim time.
 */
export function associateWorkerPr(
  tracker: PRTracker,
  workers: Worker[],
  actions: WorkerPrActions,
  pr: PullRequest,
): void {
  const tracked = tracker.get(pr.projectId, pr.number);
  if (tracked !== undefined) {
    verifyNamespace(tracker, tracked, workers, actions, pr);
    return;
  }
  if (workers.some((worker) => worker.prNumber === pr.number)) return;
  const owner =
    ownerForHeadBranch(workers, pr.headBranch, pr.number) ??
    ownerForRefs(workers, referencedIssueNumbers(`${pr.title} ${pr.headBranch}`)) ??
    (pr.body === undefined ? undefined : ownerForRefs(workers, closingKeywordRefs(pr.body)));
  if (owner !== undefined) actions.setWorkerPr(owner.id, pr.number);
}
