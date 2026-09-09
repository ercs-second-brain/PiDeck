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
import { agentKindInfo, GLOBAL_AGENT_PROJECT_ID, type AgentKind, type Session, type Worker } from "@pideck/shared";
import { boardStore } from "../store/store";
import {
  fetchProjects,
  fetchAllSessions,
  fetchWorkers,
  apiDeleteProject,
  apiSpawnAgent,
  apiTerminateAgentSession,
  startOrchestrator as apiStartOrchestrator,
  startGlobalAgent as apiStartGlobalAgent,
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
  /** The workspace-level global agent session, once one exists (projectId `global`). */
  globalAgent: Session | null;
  /** True while the global agent start request is in flight. */
  startingGlobalAgent: boolean;
  /** Forces an immediate sidebar refresh (e.g. after onboarding registers a project). */
  reload: () => void;
  /** Starts the project's orchestrator, then navigates to its terminal. */
  startOrchestrator: (projectId: string) => void;
  /** Starts (or attaches to) the global agent, then navigates to its terminal. */
  startGlobalAgent: () => void;
  /** Terminates a worker (issue #64): daemon kills the pane, worker archived;
   * refreshes after. Rejects so the terminate modal owns the error and closes
   * only on success (issue #268, delete-modal parity #172). */
  terminateWorker: (workerId: string) => Promise<void>;
  /** Deletes a project locally (issue #172): daemon teardown, GitHub repo kept.
   * Rejects so callers (the delete modal) can surface the daemon's error. */
  deleteProject: (projectId: string) => Promise<void>;
  /**
   * Spawns a preset-prompt agent-kind session (docs/agent-kinds.md, issues
   * #297/#300/#302) from the project row's ⋯ menu: researcher (carries
   * its question) or an audit kind (no input). Reloads so the new row
   * appears and navigates to the spawned session's terminal. Rejects so
   * the researcher modal can own the error.
   */
  spawnAgentSession: (projectId: string, kind: AgentKind, question?: string) => Promise<void>;
  /**
   * Terminates an agent-kind session (issue #311): the daemon kills the
   * pane and removes the record; refreshes so the row disappears. Rejects
   * so the terminate modal owns the error (#268 lifecycle).
   */
  terminateAgentSession: (sessionId: string) => Promise<void>;
  /** Opens the project onboarding wizard (sidebar "+" / empty states). */
  openOnboarding: () => void;
}

/** What {@link useSidebarData} provides — the context value minus openOnboarding. */
export type SidebarData = Omit<SidebarContextValue, "openOnboarding">;

/**
 * Sidebar poll interval (#88). The websocket hub keeps kanban/worker state
 * live; this REST poll is the sidebar's fallback — fast enough for new
 * orchestrator/worker rows to appear (starts/terminates also trigger an
 * immediate reload, and issue #269 subscribes the sidebar to the store's
 * pushed worker lifecycle events so spawned workers show up promptly),
 * slow enough not to spam the daemon. A tick while the previous load is
 * still running is skipped: pending requests never pile up.
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

/**
 * One sidebar poll: the project list plus ONE daemon-wide sessions fetch
 * (per-project groups and the workspace-level global agent — the
 * hierarchy's top layer, projectId `global`) and the per-project workers.
 */
async function loadSidebarData(): Promise<{ entries: ProjectEntry[]; globalAgent: Session | null }> {
  const [projects, allSessions] = await Promise.all([fetchProjects(), fetchAllSessions()]);
  const byProject = new Map<string, Session[]>();
  let globalAgent: Session | null = null;
  for (const session of allSessions) {
    if (session.projectId === GLOBAL_AGENT_PROJECT_ID) {
      if (session.role === "orchestrator") globalAgent = session;
      continue;
    }
    const group = byProject.get(session.projectId);
    if (group !== undefined) group.push(session);
    else byProject.set(session.projectId, [session]);
  }
  const entries = await Promise.all(
    projects.map(async (project) => {
      const workers = await fetchWorkers(project.id).catch(() => [] as Worker[]);
      return { project, sessions: byProject.get(project.id) ?? [], workers };
    }),
  );
  return { entries, globalAgent };
}

/** Polls the daemon for the sidebar's project/session/worker data. */
export function useSidebarData(onStartOrchestratorNavigate: (sessionId: string) => void): SidebarData {
  const [entries, setEntries] = useState<ProjectEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [startingProjectId, setStartingProjectId] = useState<string | null>(null);
  const [globalAgent, setGlobalAgent] = useState<Session | null>(null);
  const [startingGlobalAgent, setStartingGlobalAgent] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    const load = async () => {
      // In-flight guard (#88): never stack loads when the daemon is slow.
      if (pending) return;
      pending = true;
      try {
        const { entries: nextEntries, globalAgent } = await loadSidebarData();
        if (!cancelled) {
          setEntries(nextEntries);
          setGlobalAgent(globalAgent);
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

  // Issue #269 (B18): the REST poll above is a slow fallback. Worker spawns
  // are pushed over the websocket in real time — reload the sidebar as soon
  // as the store applies one, so the worker row appears on the next push at
  // worst (same for status changes, keeping the row badges current).
  useEffect(() => boardStore.onWorkerEvent(reload), [reload]);

  // Shared start flow (orchestrator + global agent): pending state, then
  // reload so the new row appears without waiting for the next poll tick
  // (#88), then navigate to the session's terminal.
  const startSession = useCallback(
    (start: () => Promise<{ id: string }>, setPending: (pending: boolean) => void) => {
      setPending(true);
      start()
        .then((session) => {
          reload();
          onStartOrchestratorNavigate(session.id);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setPending(false));
    },
    [onStartOrchestratorNavigate, reload],
  );

  const startOrchestrator = useCallback(
    (projectId: string) =>
      startSession(() => apiStartOrchestrator(projectId), (pending) => setStartingProjectId(pending ? projectId : null)),
    [startSession],
  );

  /** Starts (or attaches to) the global agent and refreshes so its row is live. */
  const startGlobalAgent = useCallback(
    () => startSession(apiStartGlobalAgent, setStartingGlobalAgent),
    [startSession],
  );

  /** Terminates a worker (#64) and refreshes; rethrows for the modal (issue #268). */
  const terminateWorker = useCallback(
    async (workerId: string) => {
      await apiTerminateWorker(workerId); reload();
    },
    [reload],
  );

  /** Deletes a project locally (#172) and refreshes; rethrows for the modal. */
  const deleteProject = useCallback(
    async (projectId: string) => {
      await apiDeleteProject(projectId); reload();
    },
    [reload],
  );

  // Spawns an agent-kind session (#297/#300/#302); rethrows for the modal.
  const spawnAgentSession = useCallback(
    async (projectId: string, kind: AgentKind, question?: string) => {
      const body = { kind, name: agentKindInfo(kind).label, ...(question === undefined ? {} : { question }) };
      const session = await apiSpawnAgent(projectId, body);
      reload(); onStartOrchestratorNavigate(session.id);
    },
    [onStartOrchestratorNavigate, reload],
  );

  // #311: terminates an agent-kind session and refreshes; rethrows for the modal.
  const terminateAgentSession = useCallback(
    async (sessionId: string) => {
      await apiTerminateAgentSession(sessionId); reload();
    },
    [reload],
  );
  return { entries, error, loaded, startingProjectId, globalAgent, startingGlobalAgent, reload, startOrchestrator, startGlobalAgent, terminateWorker, deleteProject, spawnAgentSession, terminateAgentSession };
}

/** Context through which the shell shares sidebar data with main-pane routes. */
export const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const value = useContext(SidebarContext);
  if (value === null) throw new Error("useSidebar must be used inside the app shell");
  return value;
}
