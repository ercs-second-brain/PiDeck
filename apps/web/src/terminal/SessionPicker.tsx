/**
 * Sidebar for the terminals page — the app's only navigation (issue #62):
 * every registered project is a top-level entry whose NAME opens that
 * project's kanban board (issue #173, the original #62 behavior). A chat
 * icon in the same row attaches the project's orchestrator terminal,
 * starting it first when absent (#53's idempotent ensure endpoint — the
 * #108 affordance moved off the name). Worker sessions are nested beneath
 * the row (issue #63) with live
 * worker status badges, then a collapsed "Archived" section for terminated
 * workers (issue #64). Clicking a session
 * attaches its terminal; clicking an archived worker opens its read-only
 * captured log (issue #104); active worker rows carry a terminate
 * affordance (✕ → centered confirm modal, issue #116) that archives the
 * worker. Each project row also carries a ⋯ context menu (issue #167) whose
 * Settings entry opens that project's settings page in the main pane.
 *
 * The "Projects" header opens the all-projects combined board; the "+"
 * button launches the project onboarding wizard. A persistent footer pinned
 * to the sidebar's bottom (issue #176) opens the global settings page
 * (worker pipeline, notifications, pi auth) in the main pane — visible
 * regardless of scroll, collapse state, or project-list errors, including
 * in the mobile drawer. Interaction state lives in
 * this component (which worker is confirming termination, which projects'
 * archived sections are expanded, which projects are collapsed); the pure
 * view pieces live in {@link ./picker-rows.tsx}.
 */

import type { Project, Session, Worker } from "@pideck/shared";
import { ArchivedSection, ProjectRow, TerminateWorkerModal, WorkerRow, workerFor } from "./picker-rows";
import { usePickerState } from "./use-picker-state";

export interface ProjectEntry {
  project: Project;
  sessions: Session[];
  workers: Worker[];
}

/**
 * One project's sidebar section: the project row (name = kanban entry +
 * chat icon = orchestrator entry, issue #173), its nested live worker rows,
 * and the collapsed archived section (issue #64).
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
  /** Session id whose worker is confirming termination (issue #64). */
  confirmingSessionId: string | null;
  /** Project id whose ⋯ context menu is open (issue #167). */
  openMenuProjectId: string | null;
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
  /** Opens the project's settings page in the main pane (issue #167). */
  onOpenSettings: (projectId: string) => void;
  onToggleMenu: (projectId: string) => void;
  onStartOrchestrator: (projectId: string) => void;
  onTerminateWorker?: (workerId: string) => void;
  /** Opens the terminate-confirmation modal on a worker row (issue #64/#116). */
  onAskTerminate: (sessionId: string) => void;
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
        pending={worker !== undefined && props.pendingTerminateWorkerId === worker.id}
        onSelectSession={props.onSelectSession}
        onTerminateWorker={props.onTerminateWorker}
        onAskTerminate={props.onAskTerminate}
      />
    );
  };

  return (
    <section className="picker-project">
      <ProjectRow
        projectName={project.name}
        projectId={project.id}
        hasOrchestrator={orchestrator !== undefined}
        boardSelected={project.id === props.selectedProjectId}
        chatSelected={orchestrator !== undefined && orchestrator.id === props.selectedSessionId}
        starting={starting}
        collapsed={props.collapsed}
        menuOpen={props.openMenuProjectId === project.id}
        onToggleCollapsed={props.onToggleCollapsed}
        onToggleMenu={props.onToggleMenu}
        onStartOrchestrator={props.onStartOrchestrator}
        onSelectProject={props.onSelectProject}
        onOpenSettings={props.onOpenSettings}
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

/** Sidebar: project name opens the board, chat icon the orchestrator (#173), workers nested beneath. */
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
  /** Opens the project's kanban board in the main pane (the project-name click, #173). */
  onSelectProject: (projectId: string) => void;
  /** Opens the project's settings page in the main pane (issue #167). */
  onOpenSettings: (projectId: string) => void;
  /** Opens the all-projects combined board (the "Projects" header). */
  onSelectAllProjects: () => void;
  /** Opens the global settings page in the main pane (the sidebar footer, #176). */
  onOpenGlobalSettings: () => void;
  /** Opens the project onboarding wizard (the "+" button). */
  onStartOnboarding: () => void;
  /** Starts (or attaches to) the project's orchestrator — the chat-icon click (#173, #53). */
  onStartOrchestrator: (projectId: string) => void;
  onTerminateWorker?: (workerId: string) => void;
}) {
  const state = usePickerState(props.entries, props.terminatingWorkerId ?? null, props.defaultArchivedOpen === true, props.defaultCollapsedProjects);

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
          confirmingSessionId={state.confirmingSessionId}
          openMenuProjectId={state.openMenuId}
          pendingTerminateWorkerId={props.terminatingWorkerId ?? null}
          archivedOpen={state.archivedOpen.has(entry.project.id)}
          onToggleArchived={state.toggleArchived}
          collapsed={state.collapsedProjects.has(entry.project.id)}
          onToggleCollapsed={state.toggleCollapsed}
          onSelectSession={props.onSelectSession}
          onSelectProject={props.onSelectProject}
          onOpenSettings={(projectId) => {
            state.closeMenu();
            props.onOpenSettings(projectId);
          }}
          onToggleMenu={state.toggleMenu}
          onStartOrchestrator={props.onStartOrchestrator}
          onTerminateWorker={props.onTerminateWorker}
          onAskTerminate={state.askTerminate}
        />
      ))}
      {/* Issue #116: the terminate confirmation is a small centered modal
          over a dimmed backdrop; Escape/Cancel dismisses, Terminate runs. */}
      {state.confirmingSession && props.onTerminateWorker && (
        <TerminateWorkerModal
          sessionName={state.confirmingSession.tmuxSession}
          pending={state.pendingTerminate}
          onConfirm={() => state.confirmTerminate(props.onTerminateWorker!)}
          onCancel={state.cancelTerminate}
        />
      )}
      {props.entries.length === 0 && !props.error && (
        <p className="picker-empty">{props.loading ? "Loading projects…" : "No projects yet — hit + to connect one."}</p>
      )}
      {props.error && <p className="picker-error">Daemon unreachable: {props.error}</p>}
      {/* Issue #176: persistent footer — sticky so it stays visible while
          the project list scrolls; flex `margin-top: auto` pins it to the
          bottom when the list is short. Renders even with no projects or a
          daemon error, so global settings are always one click away. */}
      <div className="picker-footer">
        <button
          type="button"
          className="picker-footer-settings"
          title="Global settings — worker pipeline, notifications, pi auth"
          onClick={props.onOpenGlobalSettings}
        >
          ⚙ Settings
        </button>
      </div>
    </aside>
  );
}
