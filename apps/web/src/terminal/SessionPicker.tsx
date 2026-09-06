/**
 * Session picker list for the terminal page: every registered session
 * (orchestrator + worker) grouped by project, with live worker status
 * badges. Pure/presentational so it can be rendered and tested without
 * xterm or effects.
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

/** Sidebar listing sessions grouped by project. */
export function SessionPicker(props: {
  entries: ProjectEntry[];
  error: string | null;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  const { entries, error, selectedId, onSelect } = props;

  return (
    <aside className="session-picker">
      <h2 className="picker-title">Sessions</h2>
      {entries.map(({ project, sessions, workers }) => (
        <section key={project.id} className="picker-project">
          <h3 className="picker-project-name">{project.name}</h3>
          {sessions.length === 0 ? (
            <p className="picker-empty">No active sessions.</p>
          ) : (
            <ul className="picker-list">
              {sessions.map((session) => {
                const worker =
                  session.workerId !== null
                    ? workers.find((candidate) => candidate.id === session.workerId)
                    : undefined;
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
              })}
            </ul>
          )}
        </section>
      ))}
      {entries.length === 0 && !error && (
        <p className="picker-empty">No projects with sessions yet.</p>
      )}
      {error && <p className="picker-error">Daemon unreachable: {error}</p>}
    </aside>
  );
}
