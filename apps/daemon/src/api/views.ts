import type { ProjectSettings, Session, SessionView } from "@pideck/shared";
import type { CiStatus } from "../github/schemas.js";
import {
  compactFacts,
  deriveState,
  prForWorker,
  type ProjectFacts,
  type SessionStateFacts,
} from "../reconciler/index.js";
import type { DaemonDeps } from "./deps.js";

/**
 * SessionView derivation: the eight worker states come from the reconciler's
 * `deriveState`, fed with the last GitHub read pass plus the project's
 * settings. A reviewer's parent is the live worker whose PR it reviews, and
 * the title is the issue title (for a reviewer, of the issue its PR belongs
 * to). Before the reconciler's first read pass every project has no facts,
 * so workers read as `working` and titles are null.
 */
export function sessionViews(sessions: Session[], deps: DaemonDeps): SessionView[] {
  return sessions.map((session) => sessionView(session, sessions, deps));
}

export function sessionView(session: Session, all: Session[], deps: DaemonDeps): SessionView {
  const facts = session.projectId === null ? null : (deps.reconcilerFacts?.(session.projectId) ?? null);
  const settings = projectSettings(deps, session.projectId);
  const stateFacts: SessionStateFacts = {
    pr: workerPr(session, facts),
    issueBlocked:
      facts?.issues.some((issue) => issue.number === session.issueNumber && issue.openBlockers > 0) ??
      false,
    fixAttemptsExhausted: settings !== null && session.fixAttempts >= settings.maxFixAttempts,
  };
  const { state, status } = deriveState(session, stateFacts);
  // The trace's state-derivation write site: state and facts entries land
  // here, deduped by the Trace until something actually changed.
  deps.trace.recordDerived(session.id, state, status, compactFacts(session, facts));
  return {
    session,
    state,
    status,
    parentSessionId: parentSessionId(session, all),
    title: titleFor(session, facts),
    reviewAccess: facts?.reviewAccess ?? null,
  };
}

function projectSettings(deps: DaemonDeps, projectId: string | null): ProjectSettings | null {
  if (projectId === null) return null;
  try {
    return deps.projects.settings(projectId);
  } catch {
    return null;
  }
}

function workerPr(session: Session, facts: ProjectFacts | null): {
  ciStatus: CiStatus;
  reviewDecision: string | null;
  mergeable: string;
} | null {
  if (session.persona !== "worker" || facts === null) return null;
  const pr = prForWorker(facts, session);
  return pr === null ? null : { ciStatus: pr.ciStatus, reviewDecision: pr.reviewDecision, mergeable: pr.mergeable };
}

/** A reviewer lives under the live worker whose PR it reviews. */
function parentSessionId(session: Session, all: Session[]): string | null {
  if (session.persona !== "reviewer" || session.prNumber === undefined) return null;
  const workers = all.filter(
    (s) => s.persona === "worker" && s.archivedAt === undefined && s.prNumber === session.prNumber,
  );
  const parent = workers.sort((a, b) => b.spawnedAt.localeCompare(a.spawnedAt))[0];
  return parent?.id ?? null;
}

function titleFor(session: Session, facts: ProjectFacts | null): string | null {
  if (facts === null) return null;
  const issueNumber =
    session.persona === "reviewer"
      ? facts.prs.find((pr) => pr.number === session.prNumber)?.issueNumber
      : session.issueNumber;
  if (issueNumber === undefined) return null;
  return facts.issues.find((issue) => issue.number === issueNumber)?.title ?? null;
}
