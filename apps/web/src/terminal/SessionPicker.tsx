/**
 * Sidebar for the terminals page — the app's only navigation (issue #62):
 * every registered project is a top-level entry (clicking it opens the
 * project's kanban board in the main pane), with the project's agents nested
 * underneath — the orchestrator first (or the start-orchestrator affordance
 * from issue #53 when the project has none), then its worker sessions with
 * live worker status badges. Clicking a session attaches its terminal.
 *
 * The "Projects" header opens the all-projects combined board; the "+"
 * button launches the project onboarding wizard. This component is the
 * single place project/agent rows are rendered — pure/presentational so it
 * can be rendered and tested without xterm or effects.
 */

import type { Project, Session, Worker } from "@agentskiss/shared";

export interface ProjectEntry {
  project: Project;
  sessions: Session[];
  workers: Worker[];
}

const WORKER_ACTIVE = new Set(["spawning", "running", "awaiting_ci", "fixing_ci", "addressing_review"]);

function workerBadge(worker: Worker): { label: string; className: string } {
  return WORKER_ACTIVE.has(worker.status)
    ? { label: worker.status, className: "worker-badge active" }
    : { label: worker.status, className: "worker-badge idle" };
}

/** Sidebar listing every project with its orchestrator + worker sessions nested beneath. */
export function SessionPicker(props: {
  entries: ProjectEntry[];
  error: string | null;
  /** Session currently attached in the main pane (deep link `/terminal/:id`). */
  selectedSessionId: string | null;
  /** Project whose board is currently open in the main pane. */
  selectedProjectId?: string | null;
  /** Project id currently starting its orchestrator (button pending state). */
  startingProjectId?: string | null;
  onSelectSession: (sessionId: string) => void;
  /** Opens the project's kanban board in the main pane. */
  onSelectProject: (projectId: string) => void;
  /** Opens the all-projects combined board (the "Projects" header). */
  onSelectAllProjects: () => void;
  /** Opens the project onboarding wizard (the "+" button). */
  onStartOnboarding: () => void;
  /** Starts the project's orchestrator (issue #53); button shown when it has no orchestrator session. */
  onStartOrchestrator: (projectId: string) => void;
}) {
  const {
    entries,
    error,
    selectedSessionId,
    selectedProjectId,
    startingProjectId,
    onSelectSession,
    onSelectProject,
    onSelectAllProjects,
    onStartOnboarding,
    onStartOrchestrator,
  } = props;

  const sessionButton = (session: Session, workers: Worker[]) => {
    const worker = session.workerId !== null ? workers.find((candidate) => candidate.id === session.workerId) : undefined;
    const badge = worker ? workerBadge(worker) : null;
    return (
      <li key={session.id}>
        <button
          type="button"
          className={`picker-session${session.id === selectedSessionId ? " selected" : ""}`}
          onClick={() => onSelectSession(session.id)}
        >
          <span className={`role-badge role-${session.role}`}>{session.role}</span>
          <span className="picker-session-name">{session.tmuxSession}</span>
          {badge && <span className={badge.className}>{badge.label}</span>}
        </button>
      </li>
    );
  };

  return (
    <aside className="session-picker">
      <div className="picker-header">
        <h2 className="picker-title">
          <button
            type="button"
            className="picker-title-button"
            title="Open the all-projects board"
            onClick={onSelectAllProjects}
          >
            Projects
          </button>
        </h2>
        <button type="button" className="picker-add" title="Connect a project" onClick={onStartOnboarding}>
          +
        </button>
      </div>
      {entries.map(({ project, sessions, workers }) => {
        const orchestrator = sessions.find((session) => session.role === "orchestrator");
        const workerSessions = sessions.filter((session) => session.role === "worker");
        return (
          <section key={project.id} className="picker-project">
            <button
              type="button"
              className={`picker-project-name${project.id === selectedProjectId ? " selected" : ""}`}
              title={`Open ${project.name}'s board`}
              onClick={() => onSelectProject(project.id)}
            >
              {project.name}
            </button>
            {orchestrator ? (
              <ul className="picker-list">{sessionButton(orchestrator, workers)}</ul>
            ) : (
              <button
                type="button"
                className="picker-start-orchestrator"
                disabled={startingProjectId === project.id}
                onClick={() => onStartOrchestrator(project.id)}
              >
                {startingProjectId === project.id ? "Starting…" : "Start orchestrator"}
              </button>
            )}
            {workerSessions.length > 0 && (
              <ul className="picker-list picker-workers">{workerSessions.map((session) => sessionButton(session, workers))}</ul>
            )}
          </section>
        );
      })}
      {entries.length === 0 && !error && <p className="picker-empty">No projects yet — hit + to connect one.</p>}
      {error && <p className="picker-error">Daemon unreachable: {error}</p>}
    </aside>
  );
}
