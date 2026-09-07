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
import type { Worker } from "@agentskiss/shared";
import { fetchProjects, fetchSessions, fetchWorkers, startOrchestrator as apiStartOrchestrator } from "./api";
import type { ProjectEntry } from "./SessionPicker";

export interface SidebarContextValue {
  entries: ProjectEntry[];
  error: string | null;
  /** Project id currently starting its orchestrator (button pending state). */
  startingProjectId: string | null;
  /** Forces an immediate sidebar refresh (e.g. after onboarding registers a project). */
  reload: () => void;
  /** Starts the project's orchestrator, then navigates to its terminal. */
  startOrchestrator: (projectId: string) => void;
  /** Opens the project onboarding wizard (sidebar "+" / empty states). */
  openOnboarding: () => void;
}

const POLL_INTERVAL_MS = 5000;

/** Polls the daemon for the sidebar's project/session/worker data. */
export function useSidebarData(onStartOrchestratorNavigate: (sessionId: string) => void): {
  entries: ProjectEntry[];
  error: string | null;
  startingProjectId: string | null;
  reload: () => void;
  startOrchestrator: (projectId: string) => void;
} {
  const [entries, setEntries] = useState<ProjectEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [startingProjectId, setStartingProjectId] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const projects = await fetchProjects();
        const loaded = await Promise.all(
          projects.map(async (project) => {
            const [sessions, workers] = await Promise.all([
              fetchSessions(project.id),
              fetchWorkers(project.id).catch(() => [] as Worker[]),
            ]);
            return { project, sessions, workers };
          }),
        );
        if (!cancelled) {
          setEntries(loaded);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
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
        .then((session) => onStartOrchestratorNavigate(session.id))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setStartingProjectId(null));
    },
    [onStartOrchestratorNavigate],
  );

  return { entries, error, startingProjectId, reload, startOrchestrator };
}

/** Context through which the shell shares sidebar data with main-pane routes. */
export const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const value = useContext(SidebarContext);
  if (value === null) throw new Error("useSidebar must be used inside the app shell");
  return value;
}
