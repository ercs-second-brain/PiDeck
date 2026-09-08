/**
 * Pure view pieces of the terminals sidebar (issues #63/#64/#108/#112/#114):
 * worker rows (live + archived), the terminate affordance, the project row
 * (chevron + name-as-orchestrator-entry + kanban icon), and the per-project
 * archived section. Stateless — interaction state flows in through props, so
 * these render (and unit-test) without xterm or effects.
 */

import type { ReactNode } from "react";
import type { Session, Worker } from "@agentskiss/shared";
import { workerStatusClasses } from "../lib/worker-status";

/** Issue #112: color-coded status indicator (blue/green/red, pulse while working). */
function workerBadge(worker: Worker): { label: string; className: string } {
  if (worker.status === "archived") {
    return { label: "archived", className: "worker-badge worker-badge-archived" };
  }
  return { label: worker.status, className: workerStatusClasses(worker.status, "worker-badge") };
}

/** The worker record behind a session, if any. */
export function workerFor(session: Session, workers: Worker[]): Worker | undefined {
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
export function WorkerRow(props: {
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
    // Terminated worker: history only — visibly not active, not terminable,
    // but clickable: opens the read-only archived log (issue #104).
    return (
      <li className="picker-worker-row archived">
        <button
          type="button"
          className={`picker-session picker-archived-session${props.session.id === props.selectedSessionId ? " selected" : ""}`}
          title="View the archived worker's log"
          onClick={() => props.onSelectSession(props.session.id)}
        >
          <span className="role-badge role-worker">worker</span>
          <span className="picker-session-name">{props.session.tmuxSession}</span>
          {badge && <span className={badge.className}>{badge.label}</span>}
        </button>
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
 * The project row (issue #108 + #114): collapse chevron, the project NAME
 * as the orchestrator entry, and the kanban board icon. Pure rendering.
 */
export function ProjectRow(props: {
  projectName: string;
  projectId: string;
  /** Whether the project has an orchestrator session yet (#108). */
  hasOrchestrator: boolean;
  /** The orchestrator session is the one attached in the main pane. */
  orchestratorSelected: boolean;
  /** The project's board is open in the main pane. */
  boardSelected: boolean;
  starting: boolean;
  collapsed: boolean;
  onToggleCollapsed: (projectId: string) => void;
  onStartOrchestrator: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
}) {
  return (
    <div className="picker-project-row">
      {/* Issue #114: the chevron collapses/expands all of the project's
          children (worker rows + the archived section). */}
      <button
        type="button"
        className={`picker-project-chevron${props.collapsed ? " collapsed" : ""}`}
        title={props.collapsed ? `Expand ${props.projectName}'s workers` : `Collapse ${props.projectName}'s workers`}
        aria-expanded={!props.collapsed}
        onClick={() => props.onToggleCollapsed(props.projectId)}
      >
        {props.collapsed ? "▸" : "▾"}
      </button>
      {/* Issue #108: the project NAME is the orchestrator entry — clicking
          it attaches (or starts, #53) the orchestrator terminal. */}
      <button
        type="button"
        className={`picker-project-name${props.orchestratorSelected ? " selected" : ""}`}
        title={props.hasOrchestrator ? `Attach ${props.projectName}'s orchestrator terminal` : `Start ${props.projectName}'s orchestrator`}
        disabled={props.starting}
        onClick={() => props.onStartOrchestrator(props.projectId)}
      >
        {props.starting ? "Starting…" : props.projectName}
      </button>
      <button
        type="button"
        className={`picker-project-board${props.boardSelected ? " selected" : ""}`}
        title={`Open ${props.projectName}'s kanban board`}
        disabled={props.starting}
        onClick={() => props.onSelectProject(props.projectId)}
      >
        ▦
      </button>
    </div>
  );
}

/** The per-project collapsed "Archived" section (issue #64). Pure rendering. */
export function ArchivedSection(props: {
  projectId: string;
  count: number;
  open: boolean;
  onToggle: (projectId: string) => void;
  rows: ReactNode;
}) {
  return (
    <div className="picker-archived">
      <button
        type="button"
        className="picker-archived-toggle"
        title={props.open ? "Hide archived workers" : "Show archived workers"}
        onClick={() => props.onToggle(props.projectId)}
      >
        <span className="picker-archived-chevron">{props.open ? "▾" : "▸"}</span>
        Archived ({props.count})
      </button>
      {props.open && <ul className="picker-list picker-archived-list">{props.rows}</ul>}
    </div>
  );
}
