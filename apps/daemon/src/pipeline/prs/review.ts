/**
 * The auto review agent cycle (issue #107).
 *
 * When a tracked PR is CI-green and not yet approved, the pipeline keeps a
 * review agent — a reviewer-kind worker spawned through
 * {@link spawnReviewAgent} (wiring path) — attached to the PR:
 *
 * - first green (or a new head after the author pushed): spawn a reviewer
 *   nested under the PR-authoring worker (`tracked.workerId`) and record
 *   the head SHA its round covers, respecting the project's worker
 *   concurrency cap (review agents count as workers);
 * - the author pushed since the last round: the same reviewer is re-prompted
 *   to post a fresh GitHub review;
 * - the reviewer's pane died without a decision (`reviewState` still
 *   `none`): the round is cleared so a fresh reviewer spawns;
 * - the PR got approved (or reaches any terminal state): the reviewer is
 *   archived — the loop stops re-running, per the issue.
 *
 * The reviewer itself reads the diff and posts the GitHub review (approve
 * or request changes, with inline comments) via `gh` — see
 * `agent/skills/review-pr/SKILL.md`; the daemon never posts reviews on its
 * behalf.
 */

import { ACTIVE_WORKER_STATUSES, type PullRequest, type Worker } from "@pideck/shared";

import type { PRSessionControl } from "./pipeline.js";
import { buildReReviewPrompt, buildReviewAgentPrompt, type ReviewAgentPromptOptions } from "./prompts.js";
import { DEFAULT_WORKER_PIPELINE_SETTINGS, type WorkerPipelineSettings } from "./settings.js";
import type { TrackedPR } from "./tracker.js";

/** Everything the review cycle needs from the owning pipeline. */
export interface ReviewContext {
  sessions: PRSessionControl;
  /** Toggles, read fresh on every decision (issue #106/#107). */
  settings: () => WorkerPipelineSettings | undefined;
  /** Max concurrent workers for the project; `undefined` = unbounded. */
  workerCap: () => number | undefined;
  /** `owner/name` of the PR's repository (for the reviewer's `gh --repo` calls). */
  repo: string;
}

/**
 * One poll's review-cycle drive over a CI-green tracked PR (mutates
 * `tracked`). Errors (e.g. a dead reviewer pane rejecting the re-review
 * prompt) propagate to the pipeline's poll error sink — like the CI-fix
 * prompt path — and retry on the next poll.
 */
export async function driveReview(tracked: TrackedPR, pr: PullRequest, headSha: string, ctx: ReviewContext): Promise<void> {
  if (pr.ciStatus !== "success") return;
  if (pr.reviewState === "approved") {
    await archiveReviewAgent(tracked, ctx.sessions, `PR #${tracked.prNumber} approved — review agent done`);
    return;
  }
  const settings = ctx.settings() ?? DEFAULT_WORKER_PIPELINE_SETTINGS;
  if (!settings.autoReview) return;
  // Issue #322: a conflicted PR is not reviewable — GitHub cannot merge it
  // however green its checks are. Gate the spawn (and any re-round) until
  // the author rebases; the CI-green gate above already ran.
  if (pr.mergeConflicts === true) return;

  const reviewer = tracked.reviewWorkerId === null ? undefined : ctx.sessions.getWorker(tracked.reviewWorkerId);
  if (reviewer !== undefined && ACTIVE_WORKER_STATUSES.has(reviewer.status)) {
    await reReviewIfPushed(tracked, pr, headSha, reviewer, ctx);
    return;
  }
  if (reviewer !== undefined && pr.reviewState === "none") {
    // The reviewer's round ended without a decision (pane died before it
    // could post a review): clear it so a fresh reviewer spawns below.
    tracked.reviewWorkerId = null;
    tracked.reviewedHeadSha = null;
  }
  if (tracked.reviewedHeadSha === headSha) {
    // This head was already handed to a reviewer — the round is in flight
    // or its decision (changes requested) is waiting on the author.
    return;
  }
  if (!underCap(ctx, tracked.projectId)) return; // retry on a later poll
  const spawn = ctx.sessions.spawnReviewAgent;
  if (spawn === undefined) return;
  const worker = await spawn(tracked.projectId, {
    prNumber: tracked.prNumber,
    parentWorkerId: tracked.workerId,
    prompt: buildReviewAgentPrompt(pr, promptOptions(tracked, ctx)),
  });
  if (worker === null) return; // spawn failed; retry on the next poll
  tracked.reviewWorkerId = worker.id;
  tracked.reviewedHeadSha = headSha;
  noteAuthorStatus(ctx, tracked, `PR #${tracked.prNumber}: review agent ${worker.id} reviewing`);
}

/**
 * Re-review prompt when the author pushed since the reviewer's last round.
 * A gate-held reviewer (still `spawning`, issue #56) is not typed into
 * directly — its queued initial prompt already targets the latest head, and
 * the head mismatch re-fires once it runs.
 */
async function reReviewIfPushed(tracked: TrackedPR, pr: PullRequest, headSha: string, reviewer: Worker, ctx: ReviewContext): Promise<void> {
  if (tracked.reviewedHeadSha === headSha || reviewer.status === "spawning") return;
  await ctx.sessions.sendKeys(reviewer.sessionId, buildReReviewPrompt(pr, promptOptions(tracked, ctx)), { enter: true });
  tracked.reviewedHeadSha = headSha;
  noteAuthorStatus(ctx, tracked, `PR #${tracked.prNumber}: re-review requested from the review agent`);
}

/**
 * Archives a PR's review agent (terminal PR states and approval): kills its
 * pane when the archive path exists, else marks it `done`. Clears the
 * tracker's reviewer linkage either way; never throws.
 */
export async function archiveReviewAgent(tracked: TrackedPR, sessions: PRSessionControl, message: string): Promise<void> {
  const reviewerId = tracked.reviewWorkerId;
  if (reviewerId === null) return;
  tracked.reviewWorkerId = null;
  tracked.reviewedHeadSha = null;
  const reviewer = sessions.getWorker(reviewerId);
  if (reviewer === undefined || reviewer.status === "archived") return;
  if (sessions.archiveWorker !== undefined) {
    try {
      await sessions.archiveWorker(reviewerId, message);
      return;
    } catch {
      // Fall through to the quiet status update below.
    }
  }
  try {
    sessions.updateWorkerStatus(reviewerId, "done", message);
  } catch {
    // The reviewer record vanished; the linkage is already cleared.
  }
}

/** Whether the project's worker concurrency cap has a free slot for a reviewer.
 * Occupancy is the ONE shared predicate (issue #393): active workers + live
 * workerLike kind sessions, identical on every spawn path. */
function underCap(ctx: ReviewContext, projectId: string): boolean {
  const cap = ctx.workerCap();
  if (cap === undefined) return true;
  return ctx.sessions.countProjectOccupants(projectId) < cap;
}

function promptOptions(tracked: TrackedPR, ctx: ReviewContext): ReviewAgentPromptOptions {
  return { projectId: tracked.projectId, repo: ctx.repo };
}

/**
 * Visibility only: reflects the review round on the PR-authoring worker's
 * status message while it is passively watching CI. Skipped when the author
 * is mid-fix/addressing or its record vanished.
 */
function noteAuthorStatus(ctx: ReviewContext, tracked: TrackedPR, statusMessage: string): void {
  const author = ctx.sessions.getWorker(tracked.workerId);
  if (author === undefined || author.status !== "awaiting_ci") return;
  try {
    ctx.sessions.updateWorkerStatus(author.id, "awaiting_ci", statusMessage);
  } catch {
    // The author record vanished between the read and the write.
  }
}
