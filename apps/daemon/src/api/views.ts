import type { Session, SessionView } from "@pideck/shared";

/**
 * SessionView derivation. Until the reconciler derives the eight worker
 * states from GitHub + registry facts, every session gets `state: null`,
 * workers get a placeholder `status` and everyone else an empty one, and
 * `parentSessionId` stays null. The reconciler phase replaces exactly this
 * function; no caller inspects the placeholder values.
 */
export function sessionView(session: Session): SessionView {
  return {
    session,
    state: null,
    status: session.persona === "worker" ? "working" : "",
    parentSessionId: null,
  };
}

export function sessionViews(sessions: Session[]): SessionView[] {
  return sessions.map(sessionView);
}