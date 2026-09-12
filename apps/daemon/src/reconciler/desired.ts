/**
 * Desired-state derivation — the SPEC §4 reconciliation table, pure:
 * GitHub facts + the live session registry plus settings in, actions out.
 * No I/O happens here; apply.ts executes what this returns. Unit tests
 * enumerate every table row.
 *
 * Deliveries are watermarked on the session record (see the shared Session
 * contract): losing a watermark costs at most one duplicate prompt. The
 * approved+green notice to the orchestrator is gated once per PR head in
 * `notifiedHeads`, which the caller keeps for the daemon's lifetime — a
 * restart costs at most one duplicate, like any other watermark.
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
  reReview,
  reviewChanges,
  stalled,
} from "../prompts/index.js";
import type { IssueFacts, PrFacts, ProjectFacts } from "./read.js";

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
  /** Heads already announced as approved+green; apply marks it after the send. */
  notifiedHeads: Map<number, string>;
  now: Date;
}

export function deriveActions(input: DeriveInput): Action[] {
  const { settings, facts } = input;
  const actions: Action[] = [];
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
    if (pr !== null && worker.prNumber === undefined) {
      actions.push({ kind: "attach-pr", session: worker, prNumber: pr.number });
    }
    deriveWorkerDeliveries(input, issue, worker, pr, orchestrator ?? null, nowIso, actions);
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
    const reviewable = pr.green && pr.reviewDecision !== "APPROVED" && pr.mergeable !== "CONFLICTING";
    if (reviewable && reviewer === undefined) {
      actions.push({
        kind: "spawn-reviewer",
        pr,
        initial: { lastPromptedHeadSha: pr.headSha },
      });
    }
    if (reviewer !== undefined) {
      if (pr.reviewDecision === "APPROVED") {
        actions.push({ kind: "archive", session: reviewer, reason: `PR #${pr.number} approved` });
      } else if (pr.green && pr.headSha !== reviewer.lastPromptedHeadSha) {
        actions.push({
          kind: "deliver",
          target: reviewer,
          text: reReview({ prNumber: pr.number }),
          watermark: { sessionId: reviewer.id, patch: { lastPromptedHeadSha: pr.headSha } },
        });
      }
    }
    if (pr.green && pr.reviewDecision === "APPROVED" && pr.issueNumber !== null && orchestrator !== undefined) {
      if (input.notifiedHeads.get(pr.number) !== pr.headSha) {
        actions.push({
          kind: "deliver",
          target: orchestrator,
          text: approvedGreen({ prNumber: pr.number, issueNumber: pr.issueNumber }),
          approvedGreenHead: { prNumber: pr.number, headSha: pr.headSha },
        });
      }
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

function deriveWorkerDeliveries(
  input: DeriveInput,
  issue: IssueFacts,
  worker: Session,
  pr: PrFacts | null,
  orchestrator: Session | null,
  nowIso: string,
  actions: Action[],
): void {
  const settings = input.settings;
  const login = input.facts.primaryLogin;
  const patch: SessionPatch = {};
  const deliveries: { target: Session; text: string }[] = [];

  // New issue comments: others wake the worker, the worker's own blocker
  // comment goes to the orchestrator instead.
  const newComments = issue.comments.filter((c) => c.id > (worker.lastDeliveredIssueCommentId ?? 0));
  const own = newComments.filter((c) => login !== null && c.author === login);
  const others = newComments.filter((c) => !own.includes(c));
  if (newComments.length > 0 && !(own.length > 0 && orchestrator === null)) {
    if (others.length > 0) {
      const last = others[others.length - 1]!;
      deliveries.push({
        target: worker,
        text: issueComment({ issueNumber: issue.number, commentUrl: `${issue.url}#issuecomment-${last.id}` }),
      });
    }
    if (own.length > 0 && orchestrator !== null) {
      const last = own[own.length - 1]!;
      deliveries.push({
        target: orchestrator,
        text: blockerText(issue, last.id),
      });
    }
    patch.lastDeliveredIssueCommentId = Math.max(...newComments.map((c) => c.id));
  }

  const newPrComments = pr === null ? [] : pr.reviewComments.filter((c) => c.id > (worker.lastDeliveredPrCommentId ?? 0));
  const ownPrComments = newPrComments.filter((c) => login !== null && c.author === login);
  let reviewChangesSent = false;
  if (newPrComments.some((c) => !ownPrComments.includes(c))) {
    deliveries.push({ target: worker, text: reviewChanges({ prNumber: pr!.number }) });
    reviewChangesSent = true;
  }
  if (newPrComments.length > 0) {
    patch.lastDeliveredPrCommentId = Math.max(...newPrComments.map((c) => c.id));
  }

  const newReviews = pr === null ? [] : pr.reviews.filter((r) => r.id > (worker.lastDeliveredReviewId ?? 0));
  if (!reviewChangesSent && newReviews.some((r) => r.state === "CHANGES_REQUESTED") && pr !== null) {
    deliveries.push({ target: worker, text: reviewChanges({ prNumber: pr.number }) });
  }
  if (newReviews.length > 0) {
    patch.lastDeliveredReviewId = Math.max(...newReviews.map((r) => r.id));
  }

  // A push we can attribute to this worker (its watermark is set) counts as
  // activity; with a null watermark the head is just "a PR exists".
  const pushed = pr !== null && pr.headSha !== worker.lastPromptedHeadSha;
  const attributedPush = pushed && worker.lastPromptedHeadSha !== null;
  if (pr !== null && pr.ciStatus === "failed" && pushed) {
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

  const active =
    own.length > 0 ||
    ownPrComments.length > 0 ||
    attributedPush;
  if (active) {
    patch.lastActivityAt = nowIso;
  } else {
    const baseline = worker.lastActivityAt ?? worker.spawnedAt;
    const silentMs = input.now.getTime() - Date.parse(baseline);
    if (silentMs > settings.stallMinutes * 60_000 && orchestrator !== null) {
      deliveries.push({
        target: orchestrator,
        text: stalled({ issueNumber: issue.number, stallMinutes: settings.stallMinutes }),
      });
      patch.lastActivityAt = nowIso;
    }
  }

  for (const delivery of deliveries) {
    actions.push({ kind: "deliver", ...delivery });
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
}

/** Exactly one orchestrator per project; a (re)launched one gets the briefing. */
export function orchestratorAction(input: Omit<DeriveInput, "notifiedHeads">): Action | null {
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

export function isAssigned(issue: IssueFacts, primaryLogin: string | null): boolean {
  return primaryLogin === null ? issue.assignees.length > 0 : issue.assignees.includes(primaryLogin);
}

function prForWorker(facts: { prs: PrFacts[] }, worker: Session): PrFacts | null {
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
