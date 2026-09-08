/**
 * Interaction state for the terminals sidebar (issues #64/#114/#116):
 * termination confirmation (rendered as the centered modal by
 * SessionPicker), per-project archived expansion, and per-project collapse
 * (persisted via {@link ./sidebar-collapse.ts}).
 *
 * Extracted from SessionPicker so the component stays a thin shell under
 * the max-lines-per-function budget.
 */

import { useEffect, useState } from "react";
import type { Session } from "@agentskiss/shared";
import { loadCollapsedProjects, saveCollapsedProjects } from "../lib/sidebar-collapse";

export function usePickerState(
  entries: { project: { id: string }; sessions: Session[] }[],
  terminatingWorkerId: string | null,
  /** Seeds: defaultArchivedOpen (tests/UX) + defaultCollapsedProjects (tests). */
  seedArchivedOpen = false,
  seedCollapsed?: Set<string>,
) {
  // Issue #64/#116: which worker is confirming its termination — the
  // confirm renders as a small centered modal; Escape/Cancel dismisses
  // (except while the terminate request is in flight).
  const [confirmingSessionId, setConfirmingSessionId] = useState<string | null>(null);
  // Issue #64: which projects' "Archived" sections are expanded.
  const [archivedOpen, setArchivedOpen] = useState<Set<string>>(() =>
    seedArchivedOpen ? new Set(entries.map((entry) => entry.project.id)) : new Set(),
  );
  // Issue #114: collapsed projects persist across reloads (default expanded).
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => seedCollapsed ?? loadCollapsedProjects());

  const toggleArchived = (projectId: string) =>
    setArchivedOpen((open) => {
      const next = new Set(open);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });

  const toggleCollapsed = (projectId: string) =>
    setCollapsedProjects((collapsed) => {
      const next = new Set(collapsed);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      saveCollapsedProjects(next);
      return next;
    });

  const allSessions = entries.flatMap((entry) => entry.sessions);
  const confirmingSession = confirmingSessionId ? allSessions.find((session) => session.id === confirmingSessionId) : undefined;
  const pendingTerminate = confirmingSession?.workerId != null && confirmingSession.workerId === terminatingWorkerId;

  useEffect(() => {
    if (!confirmingSession) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingTerminate) setConfirmingSessionId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmingSession, pendingTerminate]);

  const confirmTerminate = (onTerminateWorker: (workerId: string) => void) => {
    if (confirmingSession?.workerId != null) onTerminateWorker(confirmingSession.workerId);
    else setConfirmingSessionId(null);
  };

  return {
    confirmingSessionId,
    confirmingSession,
    pendingTerminate,
    askTerminate: setConfirmingSessionId,
    cancelTerminate: () => setConfirmingSessionId(null),
    confirmTerminate,
    archivedOpen,
    toggleArchived,
    collapsedProjects,
    toggleCollapsed,
  };
}
