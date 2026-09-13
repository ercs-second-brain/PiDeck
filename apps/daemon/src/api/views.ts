import type { ProjectSettings, Session, SessionView } from "@pideck/shared";
import type { CiStatus } from "../github/schemas.js";
import { sessionActive } from "../sessions/activity.js";
import { prBaton, prForWorker } from "../reconciler/desired.js";
import type { ProjectFacts } from "../reconciler/read.js";
import { deriveState, type SessionStateFacts } from "../reconciler/state.js";
import { compactFacts } from "../reconciler/trace.js";
import type { DaemonDeps } from "./deps.js";

/**
 * SessionView derivation: the eight worker states come from the reconciler's
 * `deriveState`, fed with the last GitHub read pass plus the project's
 * settings, and the PR baton decides who the PR is waiting on. A reviewer's
 * parent is the worker whose PR it reviews — the live one, else the newest
 * archived one — and the title is the issue title (for a reviewer, of the issue its PR belongs to). Before the
 * reconciler's first read pass every project has no facts, so workers read
 * as `working` and titles are null. `active` is the pi-session liveness probe
 * (mid-turn within the last minute); archived sessions never read active.
 */
export function sessionViews(sessions: Session[], deps: DaemonDeps): SessionView[] {
  return sessions.map((session) => sessionView(session, sessions, deps));
}

function sessionView(session: Session, all: Session[], deps: DaemonDeps): SessionView {
  const facts = session.projectId === null ? null : (deps.reconcilerFacts?.(session.projectId) ?? null);
  const settings = projectSettings(deps, session.projectId);
  const pr =
    facts === null
      ? null
      : session.persona === "worker"
        ? prForWorker(facts, session)
        : (facts.prs.find((pr) => pr.number === session.prNumber) ?? null);
  const stateFacts: SessionStateFacts = {
    pr: workerPr(session, facts),
    issueBlocked:
      facts?.issues.some((issue) => issue.number === session.issueNumber && issue.openBlockers > 0) ??
      false,
    fixAttemptsExhausted: settings !== null && session.fixAttempts >= settings.maxFixAttempts,
    batonHolder:
      pr === null
        ? null
        : prBaton(
            pr,
            session.persona === "reviewer" ? session : reviewerForPr(all, pr.number),
            session.persona === "worker" ? session : workerForPr(all, pr.number),
          ),
  };
  const { state, status } = deriveState(session, stateFacts);
  // The trace's state-derivation write site: state, facts, and baton entries
  // land here, deduped by the Trace until something actually changed.
  deps.trace.recordDerived(
    session.id,
    state,
    status,
    compactFacts(session, facts),
    pr === null || stateFacts.batonHolder === null
      ? null
      : { holder: stateFacts.batonHolder, prNumber: pr.number, headSha: pr.headSha },
  );
  return {
    session,
    state,
    status,
    parentSessionId: parentSessionId(session, all),
    title: titleFor(session, facts),
    reviewAccess: facts?.reviewAccess ?? null,
    active: session.archivedAt === undefined && sessionActive(deps.stateDir, session.id),
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

function workerPr(
  session: Session,
  facts: ProjectFacts | null,
): {
  ciStatus: CiStatus;
  reviewDecision: string | null;
  mergeable: string;
} | null {
  if (facts === null || (session.persona !== "worker" && session.persona !== "reviewer")) return null;
  const pr =
    session.persona === "worker"
      ? prForWorker(facts, session)
      : (facts.prs.find((pr) => pr.number === session.prNumber) ?? null);
  return pr === null ? null : { ciStatus: pr.ciStatus, reviewDecision: pr.reviewDecision, mergeable: pr.mergeable };
}

/** A reviewer lives under the worker whose PR it reviews — live, else archived. */
function parentSessionId(session: Session, all: Session[]): string | null {
  if (session.persona !== "reviewer" || session.prNumber === undefined) return null;
  const parent = workerForPr(all, session.prNumber) ?? archivedWorkerForPr(all, session.prNumber);
  return parent?.id ?? null;
}

function reviewerForPr(all: Session[], prNumber: number): Session | null {
  return all.find((s) => s.persona === "reviewer" && s.prNumber === prNumber) ?? null;
}

/** The live worker whose PR this is; the newest when several. */
function workerForPr(all: Session[], prNumber: number): Session | null {
  const workers = all.filter(
    (s) => s.persona === "worker" && s.archivedAt === undefined && s.prNumber === prNumber,
  );
  return workers.sort((a, b) => b.spawnedAt.localeCompare(a.spawnedAt))[0] ?? null;
}

/** The newest archived worker for a PR, for reviewers outliving their worker. */
function archivedWorkerForPr(all: Session[], prNumber: number): Session | null {
  const workers = all.filter(
    (s) => s.persona === "worker" && s.archivedAt !== undefined && s.prNumber === prNumber,
  );
  return workers.sort((a, b) => b.spawnedAt.localeCompare(a.spawnedAt))[0] ?? null;
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
