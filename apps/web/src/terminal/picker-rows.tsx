/**
 * Pure view pieces of the terminals sidebar (issues #63/#64/#108/#112/#114/#167/#173):
 * worker rows (live + archived), the terminate affordance, the project row
 * (chevron + name-as-kanban-entry + chat/orchestrator icon), and the
 * per-project archived section. Stateless — interaction state flows in
 * through props, so these render (and unit-test) without xterm or effects.
 */

import type { ReactNode } from "react";
import type { Session, Worker } from "@pideck/shared";
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
 * Terminate affordance for an active worker row (issue #64): a small "✕".
 * Issue #116: the confirmation is no longer inline — clicking ✕ opens the
 * small terminate modal ({@link TerminateWorkerModal}), so a stray click
 * never kills a worker.
 */
export function TerminateWorkerButton(props: { pending: boolean; onAsk: () => void }) {
  return (
    <button type="button" className="picker-terminate" title="Terminate worker" disabled={props.pending} onClick={props.onAsk}>
      ✕
    </button>
  );
}

/**
 * The terminate-confirmation modal (issue #116): small, centered, over a
 * dimmed backdrop — "Terminate worker X?" with Cancel/Terminate. Escape
 * dismisses (unless the terminate request is in flight). Pure rendering.
 */
export function TerminateWorkerModal(props: {
  /** tmux session name of the worker about to be terminated. */
  sessionName: string;
  /** The terminate request is in flight (Terminate shows "Terminating…"). */
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="modal-overlay terminate-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Terminate worker"
      onClick={props.pending ? undefined : props.onCancel}
    >
      <div className="modal-card terminate-modal" onClick={(event) => event.stopPropagation()}>
        <h3 className="terminate-modal-title">Terminate worker?</h3>
        <p className="terminate-modal-body">
          <code>{props.sessionName}</code> will be killed and archived — its pane and agent stop, its history stays
          inspectable.
        </p>
        <div className="terminate-modal-actions">
          <button type="button" className="terminate-modal-cancel" disabled={props.pending} onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="terminate-modal-confirm"
            disabled={props.pending}
            title="Terminate this worker (its pane is killed and it is archived)"
            onClick={props.onConfirm}
          >
            {props.pending ? "Terminating…" : "Terminate"}
          </button>
        </div>
      </div>
    </div>
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
  pending: boolean;
  onSelectSession: (sessionId: string) => void;
  onTerminateWorker?: (workerId: string) => void;
  onAskTerminate: (sessionId: string) => void;
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
        <TerminateWorkerButton pending={props.pending} onAsk={() => props.onAskTerminate(props.session.id)} />
      )}
    </li>
  );
}

/**
 * The project row (issue #108 + #114 + #167 + #173): collapse chevron, the
 * project NAME as the kanban entry, the chat icon as the orchestrator entry
 * (starting it when absent), and the ⋯ context menu. Pure rendering.
 */
export function ProjectRow(props: {
  projectName: string;
  projectId: string;
  /** Whether the project has an orchestrator session yet (#108). */
  hasOrchestrator: boolean;
  /** The project's board is open in the main pane (the NAME is selected). */
  boardSelected: boolean;
  /** The orchestrator terminal is the one attached in the main pane (the chat icon is selected). */
  chatSelected: boolean;
  starting: boolean;
  collapsed: boolean;
  /** The project's ⋯ context menu is open (issue #167). */
  menuOpen: boolean;
  onToggleCollapsed: (projectId: string) => void;
  onToggleMenu: (projectId: string) => void;
  /** Opens the project's settings page in the main pane (issue #167). */
  onOpenSettings: (projectId: string) => void;
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
      {/* Issue #173: the project NAME opens the project's kanban board in
          the main pane (the original #62 behavior). */}
      <button
        type="button"
        className={`picker-project-name${props.boardSelected ? " selected" : ""}`}
        title={`Open ${props.projectName}'s kanban board`}
        disabled={props.starting}
        onClick={() => props.onSelectProject(props.projectId)}
      >
        {props.projectName}
      </button>
      {/* Issue #173: the row icon is a chat bubble — clicking it attaches
          (or starts, #53) the orchestrator's pi terminal (the #108/#53
          affordance, moved off the name). */}
      <button
        type="button"
        className={`picker-project-chat${props.chatSelected ? " selected" : ""}${props.starting ? " pending" : ""}`}
        title={props.hasOrchestrator ? `Attach ${props.projectName}'s orchestrator terminal` : `Start ${props.projectName}'s orchestrator`}
        disabled={props.starting}
        onClick={() => props.onStartOrchestrator(props.projectId)}
      >
        💬
      </button>
      {/* Issue #167: the ⋯ context menu. Settings opens the project's
          settings page in the main pane; kanban stays the row's name click
          (#173), so it is not duplicated here. */}
      <button
        type="button"
        className="picker-project-menu"
        title={`${props.projectName} options`}
        aria-haspopup="menu"
        aria-expanded={props.menuOpen}
        disabled={props.starting}
        onClick={() => props.onToggleMenu(props.projectId)}
      >
        ⋯
      </button>
      {props.menuOpen && (
        <div className="picker-context-menu" role="menu" aria-label={`${props.projectName} options`}>
          <button
            type="button"
            role="menuitem"
            title={`Open ${props.projectName}'s settings`}
            onClick={() => props.onOpenSettings(props.projectId)}
          >
            Settings
          </button>
        </div>
      )}
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
