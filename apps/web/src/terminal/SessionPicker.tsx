/**
 * Session picker list for the terminal page (issue #54 IA): every registered
 * project is a top-level sidebar entry, with the project's agents nested
 * underneath it — the orchestrator first (or the start-orchestrator
 * affordance from issue #53 when the project has none), then its worker
 * sessions with live worker status badges. Pure/presentational so it can be
 * rendered and tested without xterm or effects.
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
  selectedId: string | null;
  /** Project id currently starting its orchestrator (button pending state). */
  startingProjectId?: string | null;
  onSelect: (sessionId: string) => void;
  /** Starts the project's orchestrator (issue #53); button shown when it has no orchestrator session. */
  onStartOrchestrator: (projectId: string) => void;
}) {
  const { entries, error, selectedId, startingProjectId, onSelect, onStartOrchestrator } = props;

  const sessionButton = (session: Session, workers: Worker[]) => {
    const worker = session.workerId !== null ? workers.find((candidate) => candidate.id === session.workerId) : undefined;
    const badge = worker ? workerBadge(worker) : null;
    return (
      <li key={session.id}>
        <button
          type="button"
          className={`picker-session${session.id === selectedId ? " selected" : ""}`}
          onClick={() => onSelect(session.id)}
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
      <h2 className="picker-title">Sessions</h2>
      {entries.map(({ project, sessions, workers }) => {
        const orchestrator = sessions.find((session) => session.role === "orchestrator");
        const workerSessions = sessions.filter((session) => session.role === "worker");
        return (
          <section key={project.id} className="picker-project">
            <h3 className="picker-project-name">{project.name}</h3>
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
      {entries.length === 0 && !error && <p className="picker-empty">No projects registered yet.</p>}
      {error && <p className="picker-error">Daemon unreachable: {error}</p>}
    </aside>
  );
}
