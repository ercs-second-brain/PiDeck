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
 *
 * Issue #407: the review cycle (auto agent, real GitHub reviews, the
 * review-submission watermark and the address-findings trigger) runs ONLY
 * when a review account is configured (`reviewAccountToken` in the daemon
 * settings): the reviewer pane runs `gh` as that second identity, which is
 * what makes decisive reviews possible at all. Without it — single-account
 * mode — the whole cycle is inert: no reviewer is spawned and review events
 * trigger nothing; the PR loop is worker + CI only. #408's deterministic
 * PR lifecycle keys further steps on the same watermark.
 *
 * Issue #411 (B35): the reviewer's status is platform-derived, not
 * agent-reported: `running` is set at prompt delivery (spawn/re-review) and
 * ends at the reviewer's own review submission (the #418 watermark) — the
 * resting `awaiting_ci` state — or at the PR's approval/merge/failure,
 * which archive it.
 */

import { ACTIVE_WORKER_STATUSES, type PullRequest, type Worker, type WorkerStatus } from "@pideck/shared";

import type { ReviewSubmission } from "../../github/reviews.js";
import type { PRSessionControl } from "./pipeline.js";
import { buildAddressReviewPrompt, buildReReviewPrompt, buildReviewAgentPrompt, type ReviewAgentPromptOptions } from "./prompts.js";
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
  /**
   * Whether the review account is configured (issue #407): the review
   * cycle — agent spawn, real reviews, triggers — runs only when true.
   * Absent/false = single-account mode (worker + CI only).
   */
  reviewAccount?: () => boolean;
  /**
   * The review account's GitHub login (issue #408): the reviewer spawns only
   * for PRs assigned to this user — the PR-assignment leg (the pipeline)
   * assigns worker PRs to the review identity on submission. Absent/null =
   * legacy hosts: no assignment gate (pre-#408 unconditioned spawn).
   */
  reviewUser?: () => string | null;
  /** The PR's current assignee logins (issue #408). Optional: absent degrades to none. */
  prAssignees?: string[];
  /** Injectable clock (issue #407 trigger bookkeeping). */
  now: () => Date;
  /**
   * Latest review submission on the PR this poll (issue #407), `null` when
   * there is none (or the lookup failed — the trigger degrades to the
   * inline-comment path).
   */
  latestReview?: ReviewSubmission | null;
}

/**
 * One poll's review-cycle drive over a CI-green tracked PR (mutates
 * `tracked`). Errors (e.g. a dead reviewer pane rejecting the re-review
 * prompt) propagate to the pipeline's poll error sink — like the CI-fix
 * prompt path — and retry on the next poll.
 */
export async function driveReview(tracked: TrackedPR, pr: PullRequest, headSha: string, ctx: ReviewContext, newReview: ReviewSubmission | null): Promise<void> {
  // Issue #407: no review account configured → single-account mode: the
  // review cycle (agent spawn, real reviews, review-based triggers) is
  // entirely off — the platform cannot review its own PRs with the primary
  // identity.
  if (ctx.reviewAccount?.() !== true) return;
  if (pr.ciStatus !== "success") return;
  if (pr.reviewState === "approved") {
    await archiveReviewAgent(tracked, ctx.sessions, `PR #${tracked.prNumber} approved — review agent done`);
    return;
  }
  const settings = ctx.settings() ?? DEFAULT_WORKER_PIPELINE_SETTINGS;
  // Issue #322: a conflicted PR is not reviewable — GitHub cannot merge it
  // however green its checks are. Gate the spawn (and any re-round) until
  // the author rebases; the CI-green gate above already ran.
  if (pr.mergeConflicts === true) return;

  await triggerFindingsAddress(tracked, pr, headSha, ctx, newReview, settings);
  if (!settings.autoReview) return;
  // Issue #408: the reviewer spawns only for PRs assigned to the review
  // user — the pipeline's assignment leg marks worker PRs on submission, and
  // "CI green on a PR assigned to the review user" is the spawn trigger. A
  // PR not assigned to the review identity is not in the auto-review flow;
  // with no configured review user (legacy hosts/tests) the gate is off.
  const reviewUser = ctx.reviewUser?.() ?? null;
  if (reviewUser !== null && !(ctx.prAssignees ?? []).includes(reviewUser)) return;
  await driveReviewerRound(tracked, pr, headSha, ctx);
}

/**
 * Issue #407: a completed review round deterministically triggers the
 * PR-authoring worker. A NEW review submission (tracker watermark) that
 * requests changes is actionable: prompt the author to address the findings
 * unless a prompt is already in flight (state !== watching) or the
 * review-addressing gate is off. Gated on `autoFixReviewComments`, NOT on
 * `autoReview` — findings from any reviewer (auto agent, human) must reach
 * the worker. The inline-comment delivery branch (drive.ts) covers the
 * comments themselves; this covers review-body findings.
 */
async function triggerFindingsAddress(tracked: TrackedPR, pr: PullRequest, headSha: string, ctx: ReviewContext, newReview: ReviewSubmission | null, settings: WorkerPipelineSettings): Promise<void> {
  if (newReview?.state !== "CHANGES_REQUESTED" || !settings.autoFixReviewComments || tracked.state !== "watching") return;
  await ctx.sessions.sendKeys(tracked.sessionId, buildAddressReviewPrompt(pr), { enter: true });
  tracked.state = "addressing";
  tracked.lastPromptedAt = ctx.now().toISOString();
  tracked.lastPromptedHeadSha = headSha;
  setWorkerStatusQuietly(ctx, tracked.workerId, "addressing_review", `PR #${tracked.prNumber}: addressing review findings`);
}

/** The reviewer lifecycle for a green PR: re-prompt on pushes, else spawn. */
async function driveReviewerRound(tracked: TrackedPR, pr: PullRequest, headSha: string, ctx: ReviewContext): Promise<void> {
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
 * Review-submission watermark (issue #407): records the PR's latest review
 * submission in the tracker and reports whether it is NEW — a submission the
 * platform has not observed before. The first observation pass records a
 * review already present as pre-existing (it predates the loop's watch on
 * this PR — loop start or restart resume) without triggering; `""` marks
 * "observed, none yet", so a review arriving after that pass is new. The
 * watermark never regresses. #408 keys further lifecycle steps on this
 * signal.
 */
export function observeReview(tracked: TrackedPR, latest: ReviewSubmission | null): { isNew: ReviewSubmission | null } {
  const prev = tracked.lastReviewSeenAt;
  if (prev === null) {
    tracked.lastReviewSeenAt = latest?.submittedAt ?? "";
    return { isNew: null };
  }
  if (latest === null || latest.submittedAt <= prev) return { isNew: null };
  tracked.lastReviewSeenAt = latest.submittedAt;
  return { isNew: latest };
}

/**
 * Issue #411 (B35): the reviewer's own review submission is platform truth
 * that its round has ENDED — the `running` status set at prompt delivery
 * must not outlive the round (B35: "the reviewer says running but it has
 * finished"). The reviewer drops to the PR loop's resting status
 * (`awaiting_ci`) until the author's push re-prompts it (back to `running`,
 * prompt delivery) or the PR settles (archive). The review-user attribution
 * (#407) makes this deterministic: with a configured review user, only that
 * login's submission settles the reviewer (its `gh` identity); on legacy
 * hosts without one, any new submission while this PR's reviewer is
 * mid-round counts — the reviewer is the only agent posting reviews. A PR
 * that is already approved skips this: the archival path owns the
 * reviewer's terminal transition. Gated on status `running` so gate-held
 * (`spawning`) or already-resting reviewers are untouched.
 */
export function settleReviewerRound(tracked: TrackedPR, pr: PullRequest, newReview: ReviewSubmission, ctx: ReviewContext): void {
  if (pr.reviewState === "approved") return;
  const reviewUser = ctx.reviewUser?.() ?? null;
  if (reviewUser !== null && newReview.author !== reviewUser) return; // someone else's review
  const reviewerId = tracked.reviewWorkerId;
  if (reviewerId === null) return;
  const reviewer = ctx.sessions.getWorker(reviewerId);
  if (reviewer === undefined || reviewer.status !== "running") return;
  setWorkerStatusQuietly(ctx, reviewerId, "awaiting_ci", `PR #${tracked.prNumber}: review posted — awaiting author changes`);
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
  // Issue #411 (B35): the re-review prompt is platform-delivered work — the
  // reviewer deterministically leaves its resting status for `running`
  // (the mirror of settleReviewerRound's round-end transition).
  setWorkerStatusQuietly(ctx, reviewer.id, "running", `PR #${tracked.prNumber}: re-review requested`);
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

/** Worker-status update that never throws (the record may have vanished). */
function setWorkerStatusQuietly(ctx: ReviewContext, workerId: string, status: WorkerStatus, statusMessage: string): void {
  try {
    ctx.sessions.updateWorkerStatus(workerId, status, statusMessage);
  } catch {
    // The author record vanished between the read and the write.
  }
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
