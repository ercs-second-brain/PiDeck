/**
 * Desired-state derivation — the SPEC §4 reconciliation table, pure:
 * GitHub facts + the live session registry plus settings in, actions out.
 * No I/O happens here; apply.ts executes what this returns. Unit tests
 * enumerate every table row.
 *
 * Deliveries are watermarked on the session record (see the shared Session
 * contract): losing a watermark costs at most one duplicate prompt. Two
 * once-per-X gates live in maps the caller keeps for the daemon's lifetime
 * — approved+green notices keyed on PR head (`notifiedHeads`) and stall
 * notices per session (`stallNotices`), both marked by apply after the
 * send succeeded. A restart costs at most one duplicate, like any other
 * watermark.
 *
 * One watermark covers both PR comment lists: PR conversation comments
 * (/issues/{n}/comments) and inline review-thread comments
 * (/pulls/{n}/comments) share GitHub's comment id sequence, so
 * `lastDeliveredPrCommentId` is advanced to the max id seen across both.
 *
 * The worker and the orchestrator share the primary GitHub account, so
 * issue-comment routing goes by content, not author: a comment starting
 * with `BLOCKED:` is the worker going idle (to the orchestrator); every
 * other new comment is a wake-up (to the worker).
 *
 * The PR passes between the worker and its reviewer like a baton — never
 * both active at once. The reviewer's round starts only when the worker is
 * quiet (head unchanged across polls, CI green, no fixing/addressing prompt
 * outstanding; `prBaton` says who holds it). While the reviewer holds the
 * baton, its own inline comments do not steer the worker and no CI-red
 * prompt goes out; the baton returns to the worker when its submission
 * requesting changes is observed, as one `reviewChanges` delivery. An
 * approval ends the round the same way, but the reviewer stays with its
 * worker until the PR is gone: a new head re-arms it for re-review.
 *
 * The approved+green notice fires once per head (`notifiedHeads`) and only
 * when the review account's newest review is an APPROVED review at the PR's
 * current head (`approvedAtHead`) and the worker is quiet (see
 * `approvedGreenReady`). A reviewer round is bounded the same way a worker
 * is: a reviewer that holds the baton for its prompted head past
 * `stallMinutes` without filing a review — and whose pi turn is not
 * mid-flight (`active`, the liveness probe) — is nudged once, then replaced
 * with a fresh reviewer for the same PR while the orchestrator is told.
 */

import type { Project, ProjectSettings, Session } from "@pideck/shared";
import type { SessionPatch } from "../sessions/registry.js";
import {
  approvedGreen,
  blocker,
  buildBriefing,
  ciRed,
  ciRedExhausted,
  issueComment,
  prConflict,
  reReview,
  reviewChanges,
  reviewNudge,
  reviewerStalled as reviewerStalledText,
  stalled,
} from "../prompts/index.js";
import type { GhComment, GhReview } from "../github/schemas.js";
import type { IssueFacts, PrFacts, ProjectFacts } from "./read.js";

/** Who currently holds a PR's baton, or null when nobody does. */
export type Baton = "worker" | "reviewer";

/**
 * The baton derivation. The reviewer holds it from the moment it was
 * prompted for the current head (spawn or re-review) until a submission
 * requesting changes — newer than the reviews it was prompted past — is
 * observed; the worker then holds it until it pushes (a new head). On an
 * approved PR the reviewer holds the baton only mid-round: an approval
 * newer than the reviews it was prompted past ends its round (the worker
 * reads ready); a new head re-arms it for re-review until the PR is gone.
 */
export function prBaton(
  pr: Pick<PrFacts, "headSha" | "reviewDecision" | "reviews">,
  reviewer: Session | null,
): Baton | null {
  if (reviewer === null || reviewer.lastPromptedHeadSha !== pr.headSha) return null;
  const concluded = pr.reviews.some(
    (review) =>
      review.state === "CHANGES_REQUESTED" && review.id > (reviewer.lastDeliveredReviewId ?? 0),
  );
  if (concluded) return "worker";
  if (pr.reviewDecision === "APPROVED") {
    const approvedSincePrompt = pr.reviews.some(
      (review) => review.state === "APPROVED" && review.id > (reviewer.lastDeliveredReviewId ?? 0),
    );
    return approvedSincePrompt ? null : "reviewer";
  }
  return "reviewer";
}

/**
 * The head-matched approval rule: the review account's newest review must
 * be an APPROVED review at the PR's current head. A human approval alone
 * never counts, and a push after an approval closes the gate until the
 * review account approves the new head.
 */
export function approvedAtHead(
  pr: Pick<PrFacts, "headSha" | "reviews">,
  reviewLogin: string,
): boolean {
  let newest: GhReview | null = null;
  for (const review of pr.reviews) {
    if (review.author === reviewLogin && (newest === null || review.id > newest.id)) newest = review;
  }
  return newest !== null && newest.state === "APPROVED" && newest.commitId === pr.headSha;
}

/**
 * The reviewer stall rule: the reviewer has held the baton for its prompted
 * head (armed at spawn or re-review, `lastPromptedHeadAt`) longer than
 * `stallMinutes` and filed no review that concluded the round, and its pi
 * turn is not mid-flight — the activity probe's shape distinguishes a
 * session that is still working, however slow, from one that went
 * dead-quiet. A mid-turn reviewer is left alone; a dead-quiet one is
 * nudged once per round, then replaced.
 */
export function reviewerStalled(
  pr: Pick<PrFacts, "headSha" | "reviewDecision" | "reviews">,
  reviewer: Session,
  active: boolean,
  now: Date,
  stallMinutes: number,
): boolean {
  if (active || prBaton(pr, reviewer) !== "reviewer") return false;
  if (reviewer.lastPromptedHeadAt === null) return false;
  return now.getTime() - Date.parse(reviewer.lastPromptedHeadAt) > stallMinutes * 60_000;
}

/**
 * The quiet rule for reviewer rounds: a `reviewChanges` delivery outstanding
 * to the worker for this head — this tick, or an earlier one it has not
 * answered by pushing — holds a new round back.
 */
function workerQuiet(pr: Pick<PrFacts, "headSha">, worker: Session | null): boolean {
  return worker === null || worker.lastAddressedHeadSha !== pr.headSha;
}

export type Action =
  | { kind: "spawn-global" }
  | { kind: "spawn-orchestrator"; briefing: string }
  | { kind: "spawn-worker"; issue: IssueFacts; initial: SessionPatch }
  | { kind: "spawn-reviewer"; pr: PrFacts; initial: SessionPatch }
  | { kind: "attach-pr"; session: Session; prNumber: number }
  | { kind: "archive"; session: Session; reason: string }
  | {
      kind: "deliver";
      target: Session;
      text: string;
      watermark?: { sessionId: string; patch: SessionPatch };
      /** Marked once-per-head after this delivery is sent successfully. */
      approvedGreenHead?: { prNumber: number; headSha: string };
      /** Marked once-per-silence after this delivery is sent successfully. */
      stallNotice?: { sessionId: string; at: string };
    }
  | { kind: "watermarks"; sessionId: string; patch: SessionPatch };

export interface DeriveInput {
  project: Project;
  settings: ProjectSettings;
  facts: ProjectFacts;
  /** Live (non-archived) sessions of this project. */
  live: Session[];
  /** Context-window percent per live session id, when measurable. */
  context: ReadonlyMap<string, number | null>;
  /** Whether each live session's pi turn is mid-flight right now (the
   * transcript-shape probe); a stalled reviewer still mid-turn is left
   * alone. */
  active: ReadonlyMap<string, boolean>;
  /** The review account's login; the account is required, never null. */
  reviewLogin: string;
  /** Heads already announced as approved+green; apply marks it after the send. */
  notifiedHeads: Map<number, string>;
  /** Sessions already told about their current silence; apply marks it after the send. */
  stallNotices: Map<string, string>;
  now: Date;
}

/** A worker blocker comment announces itself, so routing needs no author. */
function isBlockerComment(comment: GhComment): boolean {
  return comment.body.trimStart().startsWith("BLOCKED:");
}

export function deriveActions(input: DeriveInput): Action[] {
  const { settings, facts } = input;
  const actions: Action[] = [];
  // Workers a reviewChanges delivery went out to in this derivation; the
  // approved+green gate holds while it is outstanding.
  const reviewChangesSentTo = new Set<string>();
  const nowIso = input.now.toISOString();
  const orchestrator = input.live.find((s) => s.persona === "orchestrator");

  // workerConcurrency counts workers spawned by this derivation too.
  let spawnsLeft = settings.workerConcurrency - input.live.filter((s) => s.persona === "worker").length;

  for (const issue of facts.issues) {
    const worker = input.live.find((s) => s.persona === "worker" && s.issueNumber === issue.number);
    const assigned = isAssigned(issue, facts.primaryLogin);
    const blocked = issue.openBlockers > 0;

    if (!assigned || blocked) {
      if (worker) {
        actions.push({
          kind: "archive",
          session: worker,
          reason: !assigned ? `issue #${issue.number} unassigned` : `issue #${issue.number} blocked`,
        });
      }
      continue;
    }

    if (worker === undefined) {
      if (spawnsLeft > 0) {
        spawnsLeft--;
        actions.push({
          kind: "spawn-worker",
          issue,
          initial: { lastDeliveredIssueCommentId: maxId(issue.comments.map((c) => c.id)) },
        });
      }
      continue;
    }

    const pr = prForWorker(facts, worker);
    const firstSeenPr = pr !== null && worker.prNumber === undefined;
    if (firstSeenPr) {
      actions.push({ kind: "attach-pr", session: worker, prNumber: pr.number });
    }
    if (deriveWorkerDeliveries(input, issue, worker, pr, orchestrator ?? null, firstSeenPr, nowIso, actions)) {
      reviewChangesSentTo.add(worker.id);
    }
  }

  // A live worker whose issue no longer exists (closed, or merged via its PR),
  // or whose PR is gone (merged or closed without the issue closing).
  for (const worker of input.live.filter((s) => s.persona === "worker")) {
    if (!facts.issues.some((issue) => issue.number === worker.issueNumber)) {
      actions.push({ kind: "archive", session: worker, reason: `issue #${worker.issueNumber} closed or merged` });
    } else if (
      worker.prNumber !== undefined &&
      !facts.prs.some((pr) => pr.number === worker.prNumber)
    ) {
      actions.push({ kind: "archive", session: worker, reason: `PR #${worker.prNumber} merged or closed` });
    }
  }

  for (const pr of facts.prs) {
    const reviewer = input.live.find((s) => s.persona === "reviewer" && s.prNumber === pr.number);
    const worker =
      input.live.find((s) => s.persona === "worker" && prForWorker(facts, s)?.number === pr.number) ?? null;
    const reviewable = pr.green && pr.reviewDecision !== "APPROVED" && pr.mergeable !== "CONFLICTING";
    // A review account with no read access would 404 on every call — no
    // reviewer until the daemon's access check turns the leg back on.
    const reviewLegOn = input.facts.reviewAccess === undefined;
    // A round starts only while the worker is quiet: green (head stable,
    // CI complete) and no addressing prompt outstanding to it.
    if (reviewable && reviewer === undefined && reviewLegOn && workerQuiet(pr, worker)) {
      actions.push({
        kind: "spawn-reviewer",
        pr,
        initial: {
          lastPromptedHeadSha: pr.headSha,
          lastPromptedHeadAt: nowIso,
          lastDeliveredReviewId: maxId(pr.reviews.map((r) => r.id)),
        },
      });
    }
    if (
      reviewer !== undefined &&
      pr.green &&
      pr.mergeable !== "CONFLICTING" &&
      workerQuiet(pr, worker) &&
      // A fresh approval ends the round at the prompted head; only a new
      // head (e.g. fixes pushed after approval-with-comments) re-arms it.
      pr.headSha !== reviewer.lastPromptedHeadSha
    ) {
      actions.push({
        kind: "deliver",
        target: reviewer,
        text: reReview({ prNumber: pr.number }),
        // The re-armed reviewer knows every review filed so far; only a
        // newer submission concludes its next round.
        watermark: {
          sessionId: reviewer.id,
          patch: {
            lastPromptedHeadSha: pr.headSha,
            lastPromptedHeadAt: nowIso,
            lastDeliveredReviewId: maxId(pr.reviews.map((r) => r.id)),
          },
        },
      });
    }
    // The reviewer stall bound: a round that never files its submission must
    // not park the PR. A dead-quiet reviewer past the bound is nudged once
    // (the nudge re-arms the bound); one the nudge could not wake — the
    // silence outlived the re-armed clock — is replaced with a fresh
    // reviewer for the same PR and the orchestrator is told.
    if (
      reviewer !== undefined &&
      reviewerStalled(
        pr,
        reviewer,
        input.active.get(reviewer.id) ?? false,
        input.now,
        settings.stallMinutes,
      )
    ) {
      const noticed = input.stallNotices.get(reviewer.id);
      const nudged =
        noticed !== undefined &&
        reviewer.lastPromptedHeadAt !== null &&
        Date.parse(noticed) >= Date.parse(reviewer.lastPromptedHeadAt);
      if (!nudged) {
        actions.push({
          kind: "deliver",
          target: reviewer,
          text: reviewNudge({ prNumber: pr.number }),
          watermark: {
            sessionId: reviewer.id,
            patch: {
              lastPromptedHeadSha: pr.headSha,
              lastPromptedHeadAt: nowIso,
              lastDeliveredReviewId: maxId(pr.reviews.map((r) => r.id)),
            },
          },
          stallNotice: { sessionId: reviewer.id, at: nowIso },
        });
      } else {
        actions.push({
          kind: "archive",
          session: reviewer,
          reason: `reviewer stalled on PR #${pr.number}`,
        });
        if (orchestrator !== undefined) {
          actions.push({
            kind: "deliver",
            target: orchestrator,
            text: reviewerStalledText({ prNumber: pr.number, stallMinutes: settings.stallMinutes }),
          });
        }
      }
    }
    if (
      pr.green &&
      pr.issueNumber !== null &&
      orchestrator !== undefined &&
      input.notifiedHeads.get(pr.number) !== pr.headSha &&
      approvedAtHead(pr, input.reviewLogin) &&
      approvedGreenReady(
        pr,
        worker,
        input.facts.primaryLogin,
        worker !== null && reviewChangesSentTo.has(worker.id),
      )
    ) {
      actions.push({
        kind: "deliver",
        target: orchestrator,
        text: approvedGreen({ prNumber: pr.number, issueNumber: pr.issueNumber }),
        approvedGreenHead: { prNumber: pr.number, headSha: pr.headSha },
      });
    }
  }

  // A reviewer whose PR is gone was merged or closed.
  for (const reviewer of input.live.filter((s) => s.persona === "reviewer")) {
    if (!facts.prs.some((pr) => pr.number === reviewer.prNumber)) {
      actions.push({
        kind: "archive",
        session: reviewer,
        reason: `PR #${reviewer.prNumber} merged or closed`,
      });
    }
  }

  return actions;
}

/**
 * The approved+green notice waits for quiet. A `reviewChanges` delivery to
 * the worker — this tick, or an earlier one for this head that the worker
 * has not answered yet (its own thread replies are never delivered, so a
 * reply id past the comment watermark lifts the hold) — holds it back.
 * Stale approvals never reach here: the caller gates on the head-matched
 * approval rule (`approvedAtHead`).
 */
export function approvedGreenReady(
  pr: Pick<PrFacts, "headSha" | "reviewComments">,
  worker: Session | null,
  login: string | null,
  reviewChangesSent: boolean,
): boolean {
  if (reviewChangesSent) return false;
  if (worker === null) return true;
  if (worker.lastAddressedHeadSha !== pr.headSha) return true;
  return pr.reviewComments.some(
    (comment) => comment.author === login && comment.id > (worker.lastDeliveredPrCommentId ?? 0),
  );
}

function deriveWorkerDeliveries(
  input: DeriveInput,
  issue: IssueFacts,
  worker: Session,
  pr: PrFacts | null,
  orchestrator: Session | null,
  firstSeenPr: boolean,
  nowIso: string,
  actions: Action[],
): boolean {
  const settings = input.settings;
  const login = input.facts.primaryLogin;
  const reviewer =
    pr === null ? null : (input.live.find((s) => s.persona === "reviewer" && s.prNumber === pr.number) ?? null);
  const baton = pr === null ? null : prBaton(pr, reviewer);
  const patch: SessionPatch = {};
  const deliveries: { target: Session; text: string }[] = [];
  let stallNotice: { sessionId: string; at: string } | undefined;

  // New issue comments: a `BLOCKED:` comment is the worker going idle and
  // goes to the orchestrator; every other comment is a wake-up for the
  // worker. Both run as the primary account, so content decides, not author.
  const newComments = issue.comments.filter((c) => c.id > (worker.lastDeliveredIssueCommentId ?? 0));
  const blockers = newComments.filter(isBlockerComment);
  const wakes = newComments.filter((c) => !isBlockerComment(c));
  if (newComments.length > 0 && !(blockers.length > 0 && orchestrator === null)) {
    if (wakes.length > 0) {
      const last = wakes[wakes.length - 1]!;
      deliveries.push({
        target: worker,
        text: issueComment({ issueNumber: issue.number, commentUrl: `${issue.url}#issuecomment-${last.id}` }),
      });
    }
    if (blockers.length > 0 && orchestrator !== null) {
      const last = blockers[blockers.length - 1]!;
      deliveries.push({
        target: orchestrator,
        text: blockerText(issue, last.id),
      });
    }
    patch.lastDeliveredIssueCommentId = Math.max(...newComments.map((c) => c.id));
  }

  // PR activity reaches the worker as one reviewChanges line. Conversation
  // comments (the orchestrator's failed-alignment notes land here) are
  // always delivered; review-thread replies authored by the worker itself
  // are its push-back to the reviewer, not something to wake it for.
  const newPrComments =
    pr === null ? [] : pr.prComments.filter((c) => c.id > (worker.lastDeliveredPrCommentId ?? 0));
  const newThreadComments =
    pr === null ? [] : pr.reviewComments.filter((c) => c.id > (worker.lastDeliveredPrCommentId ?? 0));
  // Inline comments the review account files during its own round are part
  // of that round, not steering: consumed silently, delivered with the
  // submission that ends the round. Comments by anyone else always deliver.
  const reviewerRoundInFlight = baton === "reviewer";
  const fromReviewAccount = (c: GhComment) => c.author === input.reviewLogin;
  const threadForWorker = newThreadComments.filter(
    (c) => (login === null || c.author !== login) && !(reviewerRoundInFlight && fromReviewAccount(c)),
  );
  let reviewChangesSent = false;
  if (newPrComments.length > 0 || threadForWorker.length > 0) {
    deliveries.push({ target: worker, text: reviewChanges({ prNumber: pr!.number }) });
    reviewChangesSent = true;
  }
  const allNewPrIds = [...newPrComments, ...newThreadComments];
  if (allNewPrIds.length > 0) {
    patch.lastDeliveredPrCommentId = Math.max(...allNewPrIds.map((c) => c.id));
  }

  const newReviews = pr === null ? [] : pr.reviews.filter((r) => r.id > (worker.lastDeliveredReviewId ?? 0));
  const changesRequested = newReviews.some((r) => r.state === "CHANGES_REQUESTED");
  if (!reviewChangesSent && changesRequested) {
    deliveries.push({ target: worker, text: reviewChanges({ prNumber: pr!.number }) });
  }
  if (newReviews.length > 0) {
    patch.lastDeliveredReviewId = Math.max(...newReviews.map((r) => r.id));
  }
  // The submission ends the reviewer's round: the worker holds the baton on
  // this head until it pushes. Comments delivered without a submission (an
  // approval with inline comments, the orchestrator's failed-alignment
  // notes) hold the approved+green notice until the worker answers them.
  if ((reviewChangesSent || changesRequested) && pr !== null) {
    patch.lastAddressedHeadSha = pr.headSha;
  }

  // Opening the PR is worker activity, and the head it pushed is attributed
  // from first sight — so a just-pushed worker never reads as stalled while
  // CI is still pending.
  if (firstSeenPr && pr !== null) {
    patch.lastPromptedHeadSha = pr.headSha;
  }

  // A push we can attribute to this worker (its watermark was set) counts
  // as activity; with a null watermark the head is just "a PR exists".
  const pushed = pr !== null && pr.headSha !== worker.lastPromptedHeadSha;
  const attributedPush = pushed && worker.lastPromptedHeadSha !== null;
  // A PR that conflicts with main never runs CI and never gets reviewed, so
  // without this delivery the worker would sit idle until the stall bound.
  // Watermarked per head: a new push that still conflicts re-notifies.
  if (pr !== null && pr.mergeable === "CONFLICTING" && worker.lastNotifiedConflictSha !== pr.headSha) {
    deliveries.push({ target: worker, text: prConflict({ prNumber: pr.number }) });
    patch.lastNotifiedConflictSha = pr.headSha;
  }
  if (pr !== null && pr.ciStatus === "failed" && pushed && baton !== "reviewer") {
    if (worker.fixAttempts >= settings.maxFixAttempts) {
      deliveries.push({
        target: worker,
        text: ciRedExhausted({ failingChecks: pr.failingChecks, attempt: worker.fixAttempts, maxAttempts: settings.maxFixAttempts }),
      });
      patch.lastPromptedHeadSha = pr.headSha;
    } else {
      patch.fixAttempts = worker.fixAttempts + 1;
      patch.lastPromptedHeadSha = pr.headSha;
      deliveries.push({
        target: worker,
        text: ciRed({ failingChecks: pr.failingChecks, attempt: patch.fixAttempts, maxAttempts: settings.maxFixAttempts }),
      });
    }
  } else if (pr !== null && pr.green && (worker.fixAttempts > 0 || pushed)) {
    patch.fixAttempts = 0;
    patch.lastPromptedHeadSha = pr.headSha;
  }

  // Activity: the worker's own words (blocker comment, PR replies), its
  // pushes, or the PR it just opened.
  const active =
    blockers.length > 0 ||
    firstSeenPr ||
    attributedPush ||
    newPrComments.some((c) => login !== null && c.author === login) ||
    newThreadComments.some((c) => login !== null && c.author === login);
  if (active) {
    patch.lastActivityAt = nowIso;
  } else {
    const baseline = worker.lastActivityAt ?? worker.spawnedAt;
    const silentMs = input.now.getTime() - Date.parse(baseline);
    // Once per silence: a notice stands until the worker acts again, so a
    // long stall is reported once, not every stallMinutes.
    const lastNotice = input.stallNotices.get(worker.id);
    const alreadyNoticed = lastNotice !== undefined && Date.parse(lastNotice) >= Date.parse(baseline);
    if (silentMs > settings.stallMinutes * 60_000 && !alreadyNoticed && orchestrator !== null) {
      deliveries.push({
        target: orchestrator,
        text: stalled({ issueNumber: issue.number, stallMinutes: settings.stallMinutes }),
      });
      patch.lastActivityAt = nowIso;
      stallNotice = { sessionId: worker.id, at: nowIso };
    }
  }

  for (const delivery of deliveries) {
    actions.push({ kind: "deliver", ...delivery });
  }
  if (stallNotice) {
    const last = actions[actions.length - 1] as Extract<Action, { kind: "deliver" }>;
    last.stallNotice = stallNotice;
  }
  if (Object.keys(patch).length > 0) {
    if (deliveries.length > 0) {
      const last = actions[actions.length - 1] as Extract<Action, { kind: "deliver" }>;
      last.watermark = { sessionId: worker.id, patch };
    } else {
      actions.push({ kind: "watermarks", sessionId: worker.id, patch });
    }
  }

  // Replacement: context usage over the limit archives the session; the
  // next tick spawns a fresh one for the same issue/PR.
  const pct = input.context.get(worker.id) ?? null;
  if (pct !== null && pct > settings.contextLimitPercent) {
    actions.push({ kind: "archive", session: worker, reason: "context limit" });
  }

  return reviewChangesSent;
}

/** Exactly one orchestrator per project; a (re)launched one gets the briefing. */
export function orchestratorAction(
  input: Omit<DeriveInput, "notifiedHeads" | "stallNotices" | "active">,
): Action | null {
  const live = input.live.find((s) => s.persona === "orchestrator");
  if (live !== undefined) return null;
  return {
    kind: "spawn-orchestrator",
    briefing: briefingText(input.project, input.facts, input.live),
  };
}

function briefingText(project: Project, facts: ProjectFacts, live: Session[]): string {
  return buildBriefing({
    project,
    issues: facts.issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      blocked: issue.openBlockers > 0,
      assignee: issue.assignees[0] ?? null,
    })),
    prs: facts.prs.map((pr) => ({
      number: pr.number,
      issueNumber: pr.issueNumber,
      ci: pr.ciStatus === "ok" ? "green" : pr.ciStatus === "failed" ? "red" : "pending",
      review:
        pr.reviewDecision === "APPROVED"
          ? "approved"
          : pr.reviewDecision === "CHANGES_REQUESTED"
            ? "changes_requested"
            : "pending",
    })),
    sessions: live.filter((s) => s.projectId === project.id),
  });
}

/** Exactly one global session per install. */
export function deriveGlobalAction(allLive: Session[]): Action | null {
  return allLive.some((s) => s.persona === "global") ? null : { kind: "spawn-global" };
}

export function isAssigned(issue: Pick<IssueFacts, "assignees">, primaryLogin: string | null): boolean {
  return primaryLogin === null ? issue.assignees.length > 0 : issue.assignees.includes(primaryLogin);
}

/** The PR attached to a worker: its own, else the one on its issue branch. */
export function prForWorker(facts: { prs: PrFacts[] }, worker: Session): PrFacts | null {
  if (worker.prNumber !== undefined) {
    const byNumber = facts.prs.find((pr) => pr.number === worker.prNumber);
    if (byNumber !== undefined) return byNumber;
  }
  if (worker.issueNumber !== undefined) {
    return facts.prs.find((pr) => pr.issueNumber === worker.issueNumber) ?? null;
  }
  return null;
}

function maxId(ids: number[]): number | null {
  return ids.length === 0 ? null : Math.max(...ids);
}

function blockerText(issue: IssueFacts, commentId: number): string {
  return blocker({ issueNumber: issue.number, commentUrl: `${issue.url}#issuecomment-${commentId}` });
}
