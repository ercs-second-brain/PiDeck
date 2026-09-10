/**
 * The PR lifecycle state machine (issue #11, extracted from pipeline.ts so
 * the loop stays small; issue #106 adds the settings gates).
 *
 * Driven per tracked PR by the pipeline's poll: CI failure → bounded fix
 * prompts to the owning worker; new review comments → delivery to the
 * worker; pushes re-arm evaluation. The `autoFixCi` /
 * `autoFixReviewComments` toggles (issue #106) skip the respective step —
 * the worker's status message reflects why nothing is driven.
 */

import type { PullRequest, WorkerStatus } from "@pideck/shared";

import type { PRReviewComment } from "../../github/pulls.js";
import type { ReviewSubmission } from "../../github/reviews.js";
import { buildCiFixPrompt, buildReviewCommentsPrompt } from "./prompts.js";
import { driveReview, observeReview } from "./review.js";
import { DEFAULT_WORKER_PIPELINE_SETTINGS, type WorkerPipelineSettings } from "./settings.js";
import type { PRSessionControl } from "./pipeline.js";
import type { TrackedPR } from "./tracker.js";
import type { PRPipelineEvent } from "./events.js";

/** Everything the state machine needs from the owning pipeline. */
export interface DriveContext {
  sessions: PRSessionControl;
  /** Toggles, read fresh on every decision (issue #106). Default: all ON. */
  settings: () => WorkerPipelineSettings | undefined;
  /** Max concurrent workers for the project; `undefined` = unbounded (issue #107). */
  workerCap: () => number | undefined;
  /** `owner/name` of the PRs' repository (review-agent prompts, issue #107). */
  repo: string;
  /**
   * Names of the failing checks on a PR head (issue #322), fetched fresh for
   * each CI-fix prompt so the worker gets actionable targets. Optional:
   * absent (or a rejected lookup) degrades to the generic inspect-first
   * prompt.
   */
  failingChecks?: (headSha: string) => Promise<string[]>;
  /** Latest review submission on the PR this poll (issue #407). Optional: absent degrades to the inline-comment path. */
  latestReview?: ReviewSubmission | null;
  /** Whether the review account is configured (issue #407) — gates the whole review cycle. Absent = single-account mode. */
  reviewAccount?: () => boolean;
  /** Max consecutive CI-fix prompts per red streak. */
  maxFixAttempts: number;
  /** Age at which an unanswered prompt is treated as stale. */
  fixPromptTimeoutMs: number;
  /** Injectable clock. */
  now: () => Date;
  /** Terminal failure: stops driving the PR (fix-attempt exhaustion). */
  fail: (tracked: TrackedPR, reason: string, workerStatus: WorkerStatus, workerMessage: string) => PRPipelineEvent[];
}

/** One poll's drive over a tracked PR (mutates `tracked`, returns events). */
export async function driveLoop(
  tracked: TrackedPR,
  pr: PullRequest,
  headSha: string,
  comments: PRReviewComment[],
  ctx: DriveContext,
): Promise<PRPipelineEvent[]> {
  const events: PRPipelineEvent[] = [];
  const newComments = comments.filter((c) => tracked.lastSeenCommentId === null || c.id > tracked.lastSeenCommentId);
  const headChangedSincePrompt = tracked.lastPromptedHeadSha !== null && headSha !== tracked.lastPromptedHeadSha;
  const promptedAt = tracked.lastPromptedAt === null ? null : Date.parse(tracked.lastPromptedAt);
  const promptStale = promptedAt !== null && ctx.now().getTime() - promptedAt > ctx.fixPromptTimeoutMs;

  // A worker stuck on a prompt for too long is considered idle again;
  // the branches below then re-prompt (CI red) or deliver deferred comments.
  if ((tracked.state === "fixing" || tracked.state === "addressing") && promptStale) {
    tracked.state = "watching";
  }

  // Issue #407: observe the PR's latest review submission once per poll —
  // on red polls too, so a review landing during a CI streak is not
  // re-treated as pre-existing once CI goes green. A NEW submission that
  // requests changes triggers the worker in the green branch below.
  const review = observeReview(tracked, ctx.latestReview ?? null);

  if (pr.ciStatus === "failure") {
    return driveCiFailure(tracked, pr, headSha, headChangedSincePrompt, newComments, ctx, events);
  }
  if (pr.ciStatus === "success") tracked.fixAttempts = 0; // the previous red streak ended green
  const greenEvents = await driveGreen(tracked, pr, headSha, newComments, ctx, events);
  // Issue #107: the auto review agent cycle runs on green PRs (after the
  // comment-delivery branch above, which owns the author's prompt state).
  // Issue #407: `review.isNew` — a newly observed review submission — drives
  // the deterministic address-findings trigger.
  await driveReview(tracked, pr, headSha, ctx, review.isNew);
  return greenEvents;
}

/** CI red branch: drive the worker into a bounded fix cycle unless gated off. */
async function driveCiFailure(
  tracked: TrackedPR,
  pr: PullRequest,
  headSha: string,
  headChangedSincePrompt: boolean,
  newComments: PRReviewComment[],
  ctx: DriveContext,
  events: PRPipelineEvent[],
): Promise<PRPipelineEvent[]> {
  // Issue #106: `autoFixCi` OFF means the pipeline skips the CI-fix step;
  // the worker's status reflects why nothing is being driven.
  if (!settingsOf(ctx).autoFixCi) {
    setStatusIfChanged(ctx, tracked.workerId, "awaiting_ci", `PR #${tracked.prNumber}: CI failed — auto-fix CI disabled (setting)`);
    return events;
  }
  const waitingForWorker = tracked.state === "fixing" && !headChangedSincePrompt;
  if (waitingForWorker) return events;
  if (tracked.fixAttempts >= ctx.maxFixAttempts) {
    events.push(
      ...ctx.fail(
        tracked,
        `fix_attempt_limit_exhausted (${tracked.fixAttempts} attempts)`,
        "failed",
        `PR #${tracked.prNumber}: fix attempt limit (${ctx.maxFixAttempts}) exhausted — manual intervention required`,
      ),
    );
    return events;
  }
  const attempt = tracked.fixAttempts + 1;
  // Issue #322: name the failing checks in the prompt. A failed lookup must
  // never block the fix cycle — the prompt degrades to inspect-first.
  const failingChecks = await ctx.failingChecks?.(headSha).catch(() => undefined);
  const prompt = buildCiFixPrompt(pr, { attempt, maxAttempts: ctx.maxFixAttempts, comments: newComments, failingChecks });
  await ctx.sessions.sendKeys(tracked.sessionId, prompt, { enter: true });
  tracked.fixAttempts = attempt;
  tracked.state = "fixing";
  tracked.lastPromptedAt = ctx.now().toISOString();
  tracked.lastPromptedHeadSha = headSha;
  markCommentsSeen(tracked, newComments);
  setStatusQuietly(ctx, tracked.workerId, "fixing_ci", `PR #${tracked.prNumber}: CI failed — fix attempt ${attempt}/${ctx.maxFixAttempts}`);
  return events;
}

/** CI green branch: deliver review comments (gated) and re-arm on pushes. */
async function driveGreen(
  tracked: TrackedPR,
  pr: PullRequest,
  headSha: string,
  newComments: PRReviewComment[],
  ctx: DriveContext,
  events: PRPipelineEvent[],
): Promise<PRPipelineEvent[]> {
  if (tracked.state === "watching" && newComments.length > 0) {
    // Issue #106: `autoFixReviewComments` OFF means the pipeline skips
    // delivering review comments; the worker's status reflects why.
    if (!settingsOf(ctx).autoFixReviewComments) {
      setStatusIfChanged(
        ctx,
        tracked.workerId,
        "awaiting_ci",
        `PR #${tracked.prNumber}: ${newComments.length} review comment(s) — auto-fix review comments disabled (setting)`,
      );
      return events;
    }
    await ctx.sessions.sendKeys(tracked.sessionId, buildReviewCommentsPrompt(pr, newComments), { enter: true });
    tracked.state = "addressing";
    tracked.lastPromptedAt = ctx.now().toISOString();
    tracked.lastPromptedHeadSha = headSha;
    markCommentsSeen(tracked, newComments);
    setStatusQuietly(ctx, tracked.workerId, "addressing_review", `PR #${tracked.prNumber}: addressing ${newComments.length} review comment(s)`);
    return events;
  }
  if (
    (tracked.state === "fixing" || tracked.state === "addressing") &&
    tracked.lastPromptedHeadSha !== null &&
    headSha !== tracked.lastPromptedHeadSha
  ) {
    // The worker pushed after being prompted — back to watching.
    tracked.state = "watching";
    setStatusQuietly(ctx, tracked.workerId, "awaiting_ci", `PR #${tracked.prNumber}: watching CI`);
  }
  return events;
}

function markCommentsSeen(tracked: TrackedPR, comments: PRReviewComment[]): void {
  for (const comment of comments) {
    if (tracked.lastSeenCommentId === null || comment.id > tracked.lastSeenCommentId) {
      tracked.lastSeenCommentId = comment.id;
    }
  }
}

function settingsOf(ctx: DriveContext): WorkerPipelineSettings {
  return ctx.settings() ?? DEFAULT_WORKER_PIPELINE_SETTINGS;
}

function setStatusQuietly(ctx: DriveContext, workerId: string, status: WorkerStatus, statusMessage: string): void {
  try {
    ctx.sessions.updateWorkerStatus(workerId, status, statusMessage);
  } catch {
    // The worker record vanished (e.g. deleted between polls); the PR
    // loop keeps running and reconcile() cleans up if it stays gone.
  }
}

/** Skipped when the worker already carries this exact status+message — the gated branches run on every poll and must not spam identical hub broadcasts. */
function setStatusIfChanged(ctx: DriveContext, workerId: string, status: WorkerStatus, statusMessage: string): void {
  const worker = ctx.sessions.getWorker(workerId);
  if (worker !== undefined && worker.status === status && worker.statusMessage === statusMessage) return;
  setStatusQuietly(ctx, workerId, status, statusMessage);
}
