/**
 * Sidebar for the terminals page — the app's only navigation (issue #62):
 * every registered project is a top-level entry (clicking it opens the
 * project's kanban board in the main pane), with the project's agents nested
 * underneath — the orchestrator first, its worker sessions indented beneath
 * it (issue #63) with live worker status badges, then a collapsed
 * "Archived" section for terminated workers (issue #64). Clicking a session
 * attaches its terminal; active worker rows carry a terminate affordance
 * (✕ → in-place confirm) that archives the worker.
 *
 * The "Projects" header opens the all-projects combined board; the "+"
 * button launches the project onboarding wizard. Interaction state lives in
 * this component (which worker is confirming termination, which projects'
 * archived sections are expanded); the pure view pieces
 * ({@link TerminateWorkerButton}) are exported for tests.
 */

import { useState } from "react";
import type { Project, Session, Worker } from "@agentskiss/shared";

export interface ProjectEntry {
  project: Project;
  sessions: Session[];
  workers: Worker[];
}

const WORKER_ACTIVE = new Set(["spawning", "running", "awaiting_ci", "fixing_ci", "addressing_review"]);

function workerBadge(worker: Worker): { label: string; className: string } {
  if (worker.status === "archived") {
    return { label: "archived", className: "worker-badge archived" };
  }
  return WORKER_ACTIVE.has(worker.status)
    ? { label: worker.status, className: "worker-badge active" }
    : { label: worker.status, className: "worker-badge idle" };
}

/** The worker record behind a session, if any. */
function workerFor(session: Session, workers: Worker[]): Worker | undefined {
  return session.workerId !== null ? workers.find((candidate) => candidate.id === session.workerId) : undefined;
}

/**
 * Terminate affordance for an active worker row (issue #64): a small "✕"
 * that asks for confirmation in place before terminating — the first click
 * swaps it for "Terminate?" / "keep", so a stray click never kills a worker.
 */
export function TerminateWorkerButton(props: {
  confirming: boolean;
  /** The terminate request is in flight (confirm button shows "Terminating…"). */
  pending: boolean;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!props.confirming) {
    return (
      <button type="button" className="picker-terminate" title="Terminate worker" onClick={props.onAsk}>
        ✕
      </button>
    );
  }
  return (
    <span className="picker-terminate-confirm">
      <button
        type="button"
        className="picker-terminate-confirm-yes"
        disabled={props.pending}
        title="Terminate this worker (its pane is killed and it is archived)"
        onClick={props.onConfirm}
      >
        {props.pending ? "Terminating…" : "Terminate?"}
      </button>
      <button type="button" className="picker-terminate-confirm-no" onClick={props.onCancel}>
        keep
      </button>
    </span>
  );
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
  /** Worker id whose termination is in flight (confirm button pending state). */
  terminatingWorkerId?: string | null;
  /** Initial expanded state of the per-project archived sections (tests/UX). */
  defaultArchivedOpen?: boolean;
  onSelectSession: (sessionId: string) => void;
  /** Opens the project's kanban board in the main pane. */
  onSelectProject: (projectId: string) => void;
  /** Opens the all-projects combined board (the "Projects" header). */
  onSelectAllProjects: () => void;
  /** Opens the project onboarding wizard (the "+" button). */
  onStartOnboarding: () => void;
  /** Starts the project's orchestrator (issue #53); button shown when it has no orchestrator session. */
  onStartOrchestrator: (projectId: string) => void;
  /** Terminates a worker (issue #64); worker rows show the affordance when provided. */
  onTerminateWorker?: (workerId: string) => void;
}) {
  const {
    entries,
    error,
    selectedSessionId,
    selectedProjectId,
    startingProjectId,
    terminatingWorkerId,
    defaultArchivedOpen,
    onSelectSession,
    onSelectProject,
    onSelectAllProjects,
    onStartOnboarding,
    onStartOrchestrator,
    onTerminateWorker,
  } = props;

  // Issue #64 UI state: which worker row is confirming its termination, and
  // which projects' "Archived" sections are expanded (collapsed by default).
  const [confirmingSessionId, setConfirmingSessionId] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState<Set<string>>(() =>
    defaultArchivedOpen ? new Set(entries.map((entry) => entry.project.id)) : new Set<string>(),
  );

  const toggleArchived = (projectId: string) => {
    setArchivedOpen((open) => {
      const next = new Set(open);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const sessionButton = (session: Session) => (
    <button
      type="button"
      className={`picker-session${session.id === selectedSessionId ? " selected" : ""}`}
      onClick={() => onSelectSession(session.id)}
    >
      <span className={`role-badge role-${session.role}`}>{session.role}</span>
      <span className="picker-session-name">{session.tmuxSession}</span>
    </button>
  );

  const workerRow = (session: Session, workers: Worker[], archived: boolean) => {
    const worker = workerFor(session, workers);
    const badge = worker ? workerBadge(worker) : null;
    if (archived) {
      // Terminated worker: history only — visibly not active, not attachable.
      return (
        <li key={session.id} className="picker-worker-row archived">
          <span className="picker-session picker-archived-session" title="Archived worker (terminated)">
            <span className="role-badge role-worker">worker</span>
            <span className="picker-session-name">{session.tmuxSession}</span>
            {badge && <span className={badge.className}>{badge.label}</span>}
          </span>
        </li>
      );
    }
    return (
      <li key={session.id} className="picker-worker-row">
        <button
          type="button"
          className={`picker-session${session.id === selectedSessionId ? " selected" : ""}`}
          onClick={() => onSelectSession(session.id)}
        >
          <span className="role-badge role-worker">worker</span>
          <span className="picker-session-name">{session.tmuxSession}</span>
          {badge && <span className={badge.className}>{badge.label}</span>}
        </button>
        {onTerminateWorker && worker && (
          <TerminateWorkerButton
            confirming={confirmingSessionId === session.id}
            pending={terminatingWorkerId === worker.id}
            onAsk={() => setConfirmingSessionId(session.id)}
            onConfirm={() => {
              setConfirmingSessionId(null);
              onTerminateWorker(worker.id);
            }}
            onCancel={() => setConfirmingSessionId(null)}
          />
        )}
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
        // Issue #64: terminated workers move to the collapsed archived
        // section; only live workers render under the orchestrator.
        const activeWorkers = workerSessions.filter((session) => workerFor(session, workers)?.status !== "archived");
        const archivedWorkers = workerSessions.filter((session) => workerFor(session, workers)?.status === "archived");
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
              <ul className="picker-list">
                <li key={orchestrator.id}>{sessionButton(orchestrator)}</li>
              </ul>
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
            {activeWorkers.length > 0 && (
              <ul className="picker-list picker-workers">{activeWorkers.map((session) => workerRow(session, workers, false))}</ul>
            )}
            {archivedWorkers.length > 0 && (
              <div className="picker-archived">
                <button
                  type="button"
                  className="picker-archived-toggle"
                  title={archivedOpen.has(project.id) ? "Hide archived workers" : "Show archived workers"}
                  onClick={() => toggleArchived(project.id)}
                >
                  <span className="picker-archived-chevron">{archivedOpen.has(project.id) ? "▾" : "▸"}</span>
                  Archived ({archivedWorkers.length})
                </button>
                {archivedOpen.has(project.id) && (
                  <ul className="picker-list picker-archived-list">
                    {archivedWorkers.map((session) => workerRow(session, workers, true))}
                  </ul>
                )}
              </div>
            )}
          </section>
        );
      })}
      {entries.length === 0 && !error && <p className="picker-empty">No projects yet — hit + to connect one.</p>}
      {error && <p className="picker-error">Daemon unreachable: {error}</p>}
    </aside>
  );
}
