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

/**
 * One worker session row (issue #64): live workers are attachable buttons
 * with a status badge and the terminate affordance; archived workers render
 * as plain history (no badge interaction, not attachable, not terminable).
 */
function WorkerRow(props: {
  session: Session;
  workers: Worker[];
  archived: boolean;
  selectedSessionId: string | null;
  confirming: boolean;
  pending: boolean;
  onSelectSession: (sessionId: string) => void;
  onTerminateWorker?: (workerId: string) => void;
  onAskTerminate: (sessionId: string) => void;
  onCancelTerminate: () => void;
}) {
  const worker = workerFor(props.session, props.workers);
  const badge = worker ? workerBadge(worker) : null;
  if (props.archived) {
    // Terminated worker: history only — visibly not active, not attachable.
    return (
      <li className="picker-worker-row archived">
        <span className="picker-session picker-archived-session" title="Archived worker (terminated)">
          <span className="role-badge role-worker">worker</span>
          <span className="picker-session-name">{props.session.tmuxSession}</span>
          {badge && <span className={badge.className}>{badge.label}</span>}
        </span>
      </li>
    );
  }
  return (
    <li className="picker-worker-row">
      <button
        type="button"
        className={`picker-session${props.session.id === props.selectedSessionId ? " selected" : ""}`}
        onClick={() => props.onSelectSession(props.session.id)}
      >
        <span className="role-badge role-worker">worker</span>
        <span className="picker-session-name">{props.session.tmuxSession}</span>
        {badge && <span className={badge.className}>{badge.label}</span>}
      </button>
      {props.onTerminateWorker && worker && (
        <TerminateWorkerButton
          confirming={props.confirming}
          pending={props.pending}
          onAsk={() => props.onAskTerminate(props.session.id)}
          onConfirm={() => {
            props.onCancelTerminate();
            props.onTerminateWorker?.(worker.id);
          }}
          onCancel={props.onCancelTerminate}
        />
      )}
    </li>
  );
}

/**
 * One project's sidebar section: the board-opening project row, its
 * orchestrator session (or the start-orchestrator affordance, issue #53),
 * live worker rows, and the collapsed archived section (issue #64).
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
  onToggleArchived: (projectId: string) => void;
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
  // only live workers render under the orchestrator.
  const activeWorkers = workerSessions.filter((session) => workerFor(session, workers)?.status !== "archived");
  const archivedWorkers = workerSessions.filter((session) => workerFor(session, workers)?.status === "archived");

  const sessionButton = (session: Session) => (
    <button
      type="button"
      className={`picker-session${session.id === props.selectedSessionId ? " selected" : ""}`}
      onClick={() => props.onSelectSession(session.id)}
    >
      <span className={`role-badge role-${session.role}`}>{session.role}</span>
      <span className="picker-session-name">{session.tmuxSession}</span>
    </button>
  );

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
      <button type="button" className={`picker-project-name${project.id === props.selectedProjectId ? " selected" : ""}`} title={`Open ${project.name}'s board`} onClick={() => props.onSelectProject(project.id)}>
        {project.name}
      </button>
      {orchestrator ? (
        <ul className="picker-list">
          <li key={orchestrator.id}>{sessionButton(orchestrator)}</li>
        </ul>
      ) : (
        <button type="button" className="picker-start-orchestrator" disabled={props.startingProjectId === project.id} onClick={() => props.onStartOrchestrator(project.id)}>
          {props.startingProjectId === project.id ? "Starting…" : "Start orchestrator"}
        </button>
      )}
      {activeWorkers.length > 0 && (
        <ul className="picker-list picker-workers">{activeWorkers.map((session) => workerRow(session, false))}</ul>
      )}
      {archivedWorkers.length > 0 && (
        <div className="picker-archived">
          <button
            type="button"
            className="picker-archived-toggle"
            title={props.archivedOpen ? "Hide archived workers" : "Show archived workers"}
            onClick={() => props.onToggleArchived(project.id)}
          >
            <span className="picker-archived-chevron">{props.archivedOpen ? "▾" : "▸"}</span>
            Archived ({archivedWorkers.length})
          </button>
          {props.archivedOpen && (
            <ul className="picker-list picker-archived-list">
              {archivedWorkers.map((session) => workerRow(session, true))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** Sidebar listing every project with its orchestrator + worker sessions nested beneath. */
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
  onSelectSession: (sessionId: string) => void;
  /** Opens the project's kanban board in the main pane. */
  onSelectProject: (projectId: string) => void;
  /** Opens the all-projects combined board (the "Projects" header). */
  onSelectAllProjects: () => void;
  /** Opens the project onboarding wizard (the "+" button). */
  onStartOnboarding: () => void;
  onStartOrchestrator: (projectId: string) => void;
  onTerminateWorker?: (workerId: string) => void;
}) {
  // Issue #64 UI state: which worker row is confirming its termination, and
  // which projects' "Archived" sections are expanded (collapsed by default).
  const [confirmingSessionId, setConfirmingSessionId] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState<Set<string>>(() =>
    new Set(props.defaultArchivedOpen === true ? props.entries.map((entry) => entry.project.id) : []),
  );
  const toggleArchived = (projectId: string) =>
    setArchivedOpen((open) => {
      const next = new Set(open);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
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
