/**
 * Sidebar for the terminals page — the app's only navigation (issue #62):
 * every registered project is a top-level entry whose NAME is the
 * orchestrator entry (issue #108): clicking it attaches the project's
 * orchestrator terminal, starting it first when absent (#53's idempotent
 * ensure endpoint). A kanban icon in the same row opens the project's
 * board. Worker sessions are nested beneath the row (issue #63) with live
 * worker status badges, then a collapsed "Archived" section for terminated
 * workers (issue #64). Clicking a session
 * attaches its terminal; clicking an archived worker opens its read-only
 * captured log (issue #104); active worker rows carry a terminate
 * affordance (✕ → in-place confirm) that archives the worker.
 *
 * The "Projects" header opens the all-projects combined board; the "+"
 * button launches the project onboarding wizard. Interaction state lives in
 * this component (which worker is confirming termination, which projects'
 * archived sections are expanded, which projects are collapsed); the pure
 * view pieces live in {@link ./picker-rows.tsx}.
 */

import { useState } from "react";
import type { Project, Session, Worker } from "@agentskiss/shared";
import { loadCollapsedProjects, saveCollapsedProjects } from "../lib/sidebar-collapse";
import { ArchivedSection, ProjectRow, WorkerRow, workerFor } from "./picker-rows";

export interface ProjectEntry {
  project: Project;
  sessions: Session[];
  workers: Worker[];
}

/**
 * One project's sidebar section: the project row (name = orchestrator
 * entry + kanban icon, issue #108), its nested live worker rows, and the
 * collapsed archived section (issue #64).
 * Pure rendering — interaction state (termination confirmation, archived
 * expansion) comes in through props so the picker stays a thin shell.
 */
function ProjectSection(props: {
  entry: ProjectEntry;
  /** Session currently attached in the main pane (deep link `/terminal/:id`). */
  selectedSessionId: string | null;
  /** Project whose board is currently open in the main pane. */
  selectedProjectId: string | null;
  /** Project id currently starting its orchestrator (button pending state). */
  startingProjectId: string | null;
  /** Session id whose worker row is confirming termination (issue #64). */
  confirmingSessionId: string | null;
  /** Worker id whose termination request is in flight (issue #64). */
  pendingTerminateWorkerId: string | null;
  /** Whether this project's archived section is expanded (issue #64). */
  archivedOpen: boolean;
  /** Whether this project's children (workers, archive) are collapsed (issue #114). */
  collapsed: boolean;
  onToggleArchived: (projectId: string) => void;
  onToggleCollapsed: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onSelectProject: (projectId: string) => void;
  onStartOrchestrator: (projectId: string) => void;
  onTerminateWorker?: (workerId: string) => void;
  /** Opens the in-place termination confirm on a worker row (issue #64). */
  onAskTerminate: (sessionId: string) => void;
  /** Closes the in-place termination confirm. */
  onCancelTerminate: () => void;
}) {
  const { project, sessions, workers } = props.entry;
  const orchestrator = sessions.find((session) => session.role === "orchestrator");
  const workerSessions = sessions.filter((session) => session.role === "worker");
  // Issue #64: terminated workers move to the collapsed archived section;
  // only live workers render under the project row.
  const activeWorkers = workerSessions.filter((session) => workerFor(session, workers)?.status !== "archived");
  const archivedWorkers = workerSessions.filter((session) => workerFor(session, workers)?.status === "archived");
  const starting = props.startingProjectId === project.id;

  const workerRow = (session: Session, archived: boolean) => {
    const worker = workerFor(session, workers);
    return (
      <WorkerRow
        key={session.id}
        session={session}
        workers={workers}
        archived={archived}
        selectedSessionId={props.selectedSessionId}
        confirming={props.confirmingSessionId === session.id}
        pending={worker !== undefined && props.pendingTerminateWorkerId === worker.id}
        onSelectSession={props.onSelectSession}
        onTerminateWorker={props.onTerminateWorker}
        onAskTerminate={props.onAskTerminate}
        onCancelTerminate={props.onCancelTerminate}
      />
    );
  };

  return (
    <section className="picker-project">
      <ProjectRow
        projectName={project.name}
        projectId={project.id}
        hasOrchestrator={orchestrator !== undefined}
        orchestratorSelected={orchestrator !== undefined && orchestrator.id === props.selectedSessionId}
        boardSelected={project.id === props.selectedProjectId}
        starting={starting}
        collapsed={props.collapsed}
        onToggleCollapsed={props.onToggleCollapsed}
        onStartOrchestrator={props.onStartOrchestrator}
        onSelectProject={props.onSelectProject}
      />
      {!props.collapsed && activeWorkers.length > 0 && (
        <ul className="picker-list picker-workers">{activeWorkers.map((session) => workerRow(session, false))}</ul>
      )}
      {!props.collapsed && archivedWorkers.length > 0 && (
        <ArchivedSection
          projectId={project.id}
          count={archivedWorkers.length}
          open={props.archivedOpen}
          onToggle={props.onToggleArchived}
          rows={archivedWorkers.map((session) => workerRow(session, true))}
        />
      )}
    </section>
  );
}

/** Sidebar: project name = orchestrator entry (#108), workers nested beneath. */
export function SessionPicker(props: {
  entries: ProjectEntry[];
  error: string | null;
  /** Project list still loading (issue #90): empty ≠ no projects yet. */
  loading?: boolean;
  selectedSessionId: string | null;
  selectedProjectId?: string | null;
  startingProjectId?: string | null;
  /** Worker id whose termination is in flight (confirm button pending state). */
  terminatingWorkerId?: string | null;
  /** Initial expanded state of the per-project archived sections (tests/UX). */
  defaultArchivedOpen?: boolean;
  /** Seeds the collapsed-project set (tests; live state comes from localStorage, issue #114). */
  defaultCollapsedProjects?: Set<string>;
  onSelectSession: (sessionId: string) => void;
  /** Opens the project's kanban board in the main pane. */
  onSelectProject: (projectId: string) => void;
  /** Opens the all-projects combined board (the "Projects" header). */
  onSelectAllProjects: () => void;
  /** Opens the project onboarding wizard (the "+" button). */
  onStartOnboarding: () => void;
  /** Starts (or attaches to) the project's orchestrator — the project-name click (#108, #53). */
  onStartOrchestrator: (projectId: string) => void;
  onTerminateWorker?: (workerId: string) => void;
}) {
  // Issue #64 UI state: which worker row is confirming its termination, and
  // which projects' "Archived" sections are expanded (collapsed by default).
  const [confirmingSessionId, setConfirmingSessionId] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState<Set<string>>(() =>
    new Set(props.defaultArchivedOpen === true ? props.entries.map((entry) => entry.project.id) : []),
  );
  // Issue #114: collapsed projects persist across reloads (localStorage;
  // default expanded). Children = worker rows + the archived section.
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    () => props.defaultCollapsedProjects ?? loadCollapsedProjects(),
  );
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

  return (
    <aside className="session-picker">
      <div className="picker-header">
        <h2 className="picker-title">
          <button type="button" className="picker-title-button" title="Open the all-projects board" onClick={props.onSelectAllProjects}>
            Projects
          </button>
        </h2>
        <button type="button" className="picker-add" title="Connect a project" onClick={props.onStartOnboarding}>
          +
        </button>
      </div>
      {props.entries.map((entry) => (
        <ProjectSection
          key={entry.project.id}
          entry={entry}
          selectedSessionId={props.selectedSessionId}
          selectedProjectId={props.selectedProjectId ?? null}
          startingProjectId={props.startingProjectId ?? null}
          confirmingSessionId={confirmingSessionId}
          pendingTerminateWorkerId={props.terminatingWorkerId ?? null}
          archivedOpen={archivedOpen.has(entry.project.id)}
          onToggleArchived={toggleArchived}
          collapsed={collapsedProjects.has(entry.project.id)}
          onToggleCollapsed={toggleCollapsed}
          onSelectSession={props.onSelectSession}
          onSelectProject={props.onSelectProject}
          onStartOrchestrator={props.onStartOrchestrator}
          onTerminateWorker={props.onTerminateWorker}
          onAskTerminate={setConfirmingSessionId}
          onCancelTerminate={() => setConfirmingSessionId(null)}
        />
      ))}
      {props.entries.length === 0 && !props.error && (
        <p className="picker-empty">{props.loading ? "Loading projects…" : "No projects yet — hit + to connect one."}</p>
      )}
      {props.error && <p className="picker-error">Daemon unreachable: {props.error}</p>}
    </aside>
  );
}
