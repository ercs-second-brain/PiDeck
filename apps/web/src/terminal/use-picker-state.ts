/**
 * Interaction state for the terminals sidebar (issues #64/#114/#116/#167):
 * termination confirmation (rendered as the centered modal by
 * SessionPicker), per-project archived expansion, and per-project collapse
 * (persisted via {@link ./sidebar-collapse.ts}).
 *
 * Extracted from SessionPicker so the component stays a thin shell under
 * the max-lines-per-function budget.
 */

import { useEffect, useState } from "react";
import type { AgentKind, Session } from "@pideck/shared";
import { errorMessage } from "../lib/api";
import { loadCollapsedProjects, saveCollapsedProjects } from "../lib/sidebar-collapse";

/** Callbacks the pure terminate-confirm lifecycle drives (React state setters). */
interface TerminateConfirmHooks {
  setPending: (pending: boolean) => void;
  setError: (error: string | null) => void;
  close: () => void;
}

/**
 * The terminate-confirm modal lifecycle (issue #268): the confirm button
 * runs the terminate request, keeps the modal pending while it is in
 * flight, **closes the modal on success** (previously the modal stayed open
 * after a successful terminate and the worker seemed un-terminated), and
 * keeps it open with the failure message on error — mirroring the
 * delete-confirmation lifecycle (issue #172).
 *
 * Pure and hook-free so the lifecycle is testable without a DOM renderer.
 */
export async function runTerminateConfirm(
  workerId: string | null,
  terminate: (workerId: string) => Promise<void>,
  hooks: TerminateConfirmHooks,
): Promise<void> {
  if (workerId === null) {
    hooks.close(); // nothing to terminate (stale confirm): dismiss
    return;
  }
  hooks.setPending(true);
  hooks.setError(null);
  try {
    await terminate(workerId);
    hooks.close();
  } catch (err) {
    hooks.setError(errorMessage(err));
  } finally {
    hooks.setPending(false);
  }
}

/**
 * Delete-confirmation interaction state (issue #172): which project is
 * confirming its deletion (rendered as the centered modal by SessionPicker),
 * in-flight/error flags, and the async confirm runner — request goes out,
 * failures surface inside the modal, success closes it.
 */
function useDeleteConfirm() {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async (onDeleteProject: (projectId: string) => Promise<void>) => {
    if (confirmingId === null) return;
    setPending(true);
    setError(null);
    try {
      await onDeleteProject(confirmingId);
      setConfirmingId(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return {
    confirmingId,
    pending,
    error,
    ask: setConfirmingId,
    cancel: () => setConfirmingId(null),
    confirm,
  };
}

/**
 * Terminate-confirmation interaction state (issue #268): in-flight/error
 * flags for the terminate request, driven by the pure {@link
 * runTerminateConfirm} lifecycle — pending while in flight, the modal
 * closed on success, open with the daemon's error on failure (delete-modal
 * parity, issue #172). Mirrors {@link useDeleteConfirm}.
 */
function useTerminateConfirm() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = (workerId: string | null, terminate: (workerId: string) => Promise<void>, close: () => void) =>
    runTerminateConfirm(workerId, terminate, { setPending, setError, close });
  return { pending, error, confirm };
}

/**
 * Input-taking spawn interaction state (issues #297/#300/#302 + #324):
 * which project + kind is asking for its question (rendered as a small
 * centered modal by SessionPicker — one per kind whose shared spec
 * takesInput, the investigator today), in-flight/error flags, and the
 * async confirm runner — request goes out, failures surface inside the
 * modal, success closes it. Mirrors {@link useDeleteConfirm}.
 */
function useInvestigatorAsk() {
  const [confirming, setConfirming] = useState<{ projectId: string; kind: AgentKind } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async (
    question: string,
    onSpawn: (projectId: string, kind: AgentKind, question: string) => Promise<void>,
  ) => {
    if (confirming === null) return;
    setPending(true);
    setError(null);
    try {
      await onSpawn(confirming.projectId, confirming.kind, question);
      setConfirming(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  // The modal dismisses on Escape (except while the spawn request is in flight).
  useEffect(() => {
    if (confirming === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) setConfirming(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, pending]);

  return {
    confirming,
    pending,
    error,
    ask: (projectId: string, kind: AgentKind) => setConfirming({ projectId, kind }),
    cancel: () => setConfirming(null),
    confirm,
  };
}

export function usePickerState(
  entries: { project: { id: string }; sessions: Session[] }[],
  terminatingWorkerId: string | null,
  /** Seeds: defaultArchivedOpen (tests/UX) + defaultCollapsedProjects (tests). */
  seedArchivedOpen = false,
  seedCollapsed?: Set<string>,
) {
  // Issue #64/#116: which worker is confirming its termination (modal #268).
  const [confirmingSessionId, setConfirmingSessionId] = useState<string | null>(null);
  const terminateConfirm = useTerminateConfirm(); // worker rows + agent-kind rows (#311) share the #268 lifecycle
  // Issue #64: which projects' "Archived" sections are expanded.
  const [archivedOpen, setArchivedOpen] = useState<Set<string>>(() =>
    seedArchivedOpen ? new Set(entries.map((entry) => entry.project.id)) : new Set(),
  );
  // Issue #114: collapsed projects persist across reloads (default expanded).
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => seedCollapsed ?? loadCollapsedProjects());
  // Issue #167: which project's ⋯ context menu is open (one at a time).
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  // Issues #297/#300/#302 + #324: the question modal for takesInput kinds.
  const investigatorAsk = useInvestigatorAsk();
  // Issue #172: the delete-confirmation interaction state (its own hook).
  const deleteConfirm = useDeleteConfirm();

  const toggleArchived = (projectId: string) =>
    setArchivedOpen((open) => {
      const next = new Set(open);
      if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
      return next;
    });

  const toggleCollapsed = (projectId: string) =>
    setCollapsedProjects((collapsed) => {
      const next = new Set(collapsed);
      if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
      saveCollapsedProjects(next);
      return next;
    });

  const allSessions = entries.flatMap((entry) => entry.sessions);
  const confirmingSession = confirmingSessionId ? allSessions.find((session) => session.id === confirmingSessionId) : undefined;
  // In flight: the confirm's own request, or the terminatingWorkerId overlay (tests).
  const pendingTerminate =
    terminateConfirm.pending || (confirmingSession?.workerId != null && confirmingSession.workerId === terminatingWorkerId);

  useEffect(() => {
    if (!confirmingSession) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingTerminate) setConfirmingSessionId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmingSession, pendingTerminate]);

  // Issue #172: the delete modal dismisses on Escape (not while pending).
  useEffect(() => {
    if (deleteConfirm.confirmingId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleteConfirm.pending) deleteConfirm.cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteConfirm]);

  // Issue #167: an open ⋯ context menu closes on Escape or on any click
  // outside the menu and its toggle (the toggle's own click re-toggles).
  useEffect(() => {
    if (openMenuId === null) return;
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".picker-project-menu, .picker-context-menu") !== null) return;
      setOpenMenuId(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenuId(null);
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [openMenuId]);

  const confirmTerminate = (onTerminateWorker: (workerId: string) => Promise<void>) =>
    terminateConfirm.confirm(confirmingSession?.workerId ?? null, onTerminateWorker, () => setConfirmingSessionId(null));
  // #311: agent sessions have no worker record — the confirm target is the session id.
  const confirmTerminateAgent = (onTerminateAgentSession: (sessionId: string) => Promise<void>) =>
    terminateConfirm.confirm(confirmingSessionId, onTerminateAgentSession, () => setConfirmingSessionId(null));

  return {
    confirmingSessionId,
    confirmingSession,
    pendingTerminate,
    terminateError: terminateConfirm.error,
    askTerminate: setConfirmingSessionId,
    cancelTerminate: () => setConfirmingSessionId(null),
    confirmTerminate,
    confirmTerminateAgent,
    deleteConfirm,
    archivedOpen,
    toggleArchived,
    collapsedProjects,
    toggleCollapsed,
    openMenuId,
    toggleMenu: (projectId: string) => setOpenMenuId((current) => (current === projectId ? null : projectId)),
    closeMenu: () => setOpenMenuId(null),
    investigatorAsk,
  };
}
