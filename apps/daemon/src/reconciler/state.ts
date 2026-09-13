/**
 * The eight worker states, derived purely from a session record and the
 * GitHub facts bound to it — never agent-reported. Returns `null` state for
 * orchestrator and global sessions (they have no worker row state) plus a
 * one-line status either way, shaped for the API's SessionView.
 */

import type { Session, WorkerState } from "@pideck/shared";
import type { CiStatus } from "../github/schemas.js";

export interface SessionStateFacts {
  /** The PR attached to this session, when one exists. */
  pr: {
    ciStatus: CiStatus;
    reviewDecision: string | null;
    mergeable: string;
    /** The review account's APPROVED review at the current head. */
    approvedAtHead: boolean;
  } | null;
  /** The session's issue has open `blocked by` links. */
  issueBlocked: boolean;
  /** CI fix attempts are used up and the worker was told to go idle. */
  fixAttemptsExhausted: boolean;
  /** Who holds the attached PR's baton, or null when nobody does. */
  batonHolder: "worker" | "reviewer" | null;
}

export function deriveState(
  session: Session,
  facts: SessionStateFacts,
): { state: WorkerState | null; status: string } {
  if (session.archivedAt !== undefined) {
    return { state: "done", status: `archived ${session.archivedAt}` };
  }
  switch (session.persona) {
    case "reviewer":
      return {
        state: "in_review",
        status:
          facts.batonHolder === "worker"
            ? session.prNumber === undefined
              ? "awaiting author"
              : `awaiting author on PR #${session.prNumber}`
            : facts.pr?.reviewDecision === "APPROVED"
              ? session.prNumber === undefined
                ? "approved, awaiting merge"
                : `approved PR #${session.prNumber}, awaiting merge`
              : session.prNumber === undefined
                ? "reviewing"
                : `reviewing PR #${session.prNumber}`,
      };
    case "orchestrator":
      return { state: null, status: "orchestrator" };
    case "global":
      return { state: null, status: "global agent" };
    case "worker": {
      const issue = session.issueNumber === undefined ? "" : ` on #${session.issueNumber}`;
      if (facts.issueBlocked) {
        return { state: "blocked", status: `blocked${issue}` };
      }
      if (facts.fixAttemptsExhausted) {
        return { state: "blocked", status: `fix attempts exhausted${issue}` };
      }
      if (facts.pr === null) {
        return { state: "working", status: `working${issue}` };
      }
      const label = `PR #${session.prNumber ?? "?"}`;
      if (facts.pr.mergeable === "CONFLICTING") {
        return { state: "fixing", status: `conflicts with main on ${label}` };
      }
      // The baton says who the PR is waiting on: the reviewer holds it — the
      // worker is quiet — while it reviews, and the worker holds it from the
      // review submission until its next push.
      if (facts.batonHolder === "reviewer") {
        return { state: "in_review", status: `awaiting review on ${label}` };
      }
      if (facts.batonHolder === "worker" || facts.pr.reviewDecision === "CHANGES_REQUESTED") {
        return { state: "addressing", status: `addressing review on ${label}` };
      }
      if (facts.pr.ciStatus === "failed") {
        return { state: "fixing", status: `fixing CI on ${label}` };
      }
      if (facts.pr.ciStatus === "pending") {
        return { state: "ci", status: `CI running for ${label}` };
      }
      // Ready means the head-matched approval: the review account's APPROVED
      // review at the current head — the same rule the merge notice gates on,
      // not GitHub's (possibly stale) reviewDecision.
      if (facts.pr.approvedAtHead) {
        return { state: "ready", status: `approved and green, ${label}` };
      }
      return { state: "in_review", status: `awaiting review on ${label}` };
    }
  }
}
