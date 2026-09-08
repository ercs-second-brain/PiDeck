/**
 * Sidebar data (issue #62): every registered project with its orchestrator +
 * worker sessions and live worker status, polled from the daemon REST API.
 *
 * The terminals page is the whole app now, so the sidebar (and its data) is
 * owned by the app shell and shared via React context: the picker renders
 * the rows, while main-pane routes (terminal, boards) read what they need —
 * the selected session lookup, or the zero-project onboarding CTA.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Worker } from "@pideck/shared";
import {
  fetchProjects,
  fetchSessions,
  fetchWorkers,
  startOrchestrator as apiStartOrchestrator,
  terminateWorker as apiTerminateWorker,
} from "../lib/api";
import type { ProjectEntry } from "./SessionPicker";

export interface SidebarContextValue {
  entries: ProjectEntry[];
  error: string | null;
  /**
   * True once the first project-list fetch completed successfully (issue
   * #90): an empty `entries` before this point means "not loaded yet", not
   * "no projects" — onboarding/first-run UI must not fire on loading state.
   */
  loaded: boolean;
  /** Project id currently starting its orchestrator (button pending state). */
  startingProjectId: string | null;
  /** Forces an immediate sidebar refresh (e.g. after onboarding registers a project). */
  reload: () => void;
  /** Starts the project's orchestrator, then navigates to its terminal. */
  startOrchestrator: (projectId: string) => void;
  /** Terminates a worker (issue #64): daemon kills the pane, worker archived; refreshes after. */
  terminateWorker: (workerId: string) => void;
  /** Opens the project onboarding wizard (sidebar "+" / empty states). */
  openOnboarding: () => void;
}

/**
 * Sidebar poll interval (#88). The websocket hub keeps kanban/worker state
 * live; this REST poll is the sidebar's fallback — fast enough for new
 * orchestrator/worker rows to appear (starts/terminates also trigger an
 * immediate reload), slow enough not to spam the daemon. A tick while the
 * previous load is still running is skipped: pending requests never pile up.
 */
const POLL_INTERVAL_MS = 15_000;

/**
 * First-run detection (issue #90): the onboarding modal auto-opens only when
 * the project list actually loaded and is genuinely empty — the not-yet-
 * loaded zero-entries state must not be mistaken for "no projects".
 */
export function shouldAutoOpenOnboarding(state: { loaded: boolean; error: string | null; entryCount: number }): boolean {
  return state.loaded && state.error === null && state.entryCount === 0;
}

/** Polls the daemon for the sidebar's project/session/worker data. */
export function useSidebarData(onStartOrchestratorNavigate: (sessionId: string) => void): {
  entries: ProjectEntry[];
  error: string | null;
  loaded: boolean;
  startingProjectId: string | null;
  reload: () => void;
  startOrchestrator: (projectId: string) => void;
  terminateWorker: (workerId: string) => void;
} {
  const [entries, setEntries] = useState<ProjectEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [startingProjectId, setStartingProjectId] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    const load = async () => {
      // In-flight guard (#88): never stack loads when the daemon is slow —
      // the still-running load's result is fresher than a duplicate tick.
      if (pending) return;
      pending = true;
      try {
        const projects = await fetchProjects();
        const nextEntries = await Promise.all(
          projects.map(async (project) => {
            const [sessions, workers] = await Promise.all([
              fetchSessions(project.id),
              fetchWorkers(project.id).catch(() => [] as Worker[]),
            ]);
            return { project, sessions, workers };
          }),
        );
        if (!cancelled) {
          setEntries(nextEntries);
          setError(null);
          setLoaded(true);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [reloadTick]);

  const reload = useCallback(() => setReloadTick((tick) => tick + 1), []);

  const startOrchestrator = useCallback(
    (projectId: string) => {
      setStartingProjectId(projectId);
      apiStartOrchestrator(projectId)
        .then((session) => {
          // Reload now so the new orchestrator row (and its attachable
          // terminal) appears without waiting for the next poll tick (#88:
          // the slower fallback poll must not slow down starting work).
          reload();
          onStartOrchestratorNavigate(session.id);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setStartingProjectId(null));
    },
    [onStartOrchestratorNavigate, reload],
  );

  /** Terminates a worker (issue #64) and refreshes so the archive shows immediately. */
  const terminateWorker = useCallback(
    (workerId: string) => {
      apiTerminateWorker(workerId)
        .then(() => reload())
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [reload],
  );

  return { entries, error, loaded, startingProjectId, reload, startOrchestrator, terminateWorker };
}

/** Context through which the shell shares sidebar data with main-pane routes. */
export const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const value = useContext(SidebarContext);
  if (value === null) throw new Error("useSidebar must be used inside the app shell");
  return value;
}
