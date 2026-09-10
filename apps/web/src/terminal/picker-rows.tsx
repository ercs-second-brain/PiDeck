/**
 * Pure view pieces of the terminals sidebar (issues #63/#64/#108/#112/#114/#167/#172/#173):
 * worker rows (live + archived), the terminate affordance, the project row
 * (chevron + name-as-kanban-entry + chat/orchestrator icon), the per-project
 * archived section, the bottom add-project row (issue #259), the ⋯ menu's
 * delete entry, the rows' ⋯ context menus (issue #355), and the
 * confirmation modals. Stateless — interaction state
 * flows in through props, so these render (and unit-test) without xterm or
 * effects.
 */

import type { ReactNode } from "react";
import type { AgentKindSpec, Session, Worker } from "@pideck/shared";
import { ProjectMenu, type ProjectMenuCallbacks } from "./picker-project-menu";
import { formatRunningDuration } from "../lib/format-timestamp";
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
 * Row ⋯ context menu (issue #355, B5): the terminate/delete affordance lives
 * behind a ⋯ toggle instead of a standalone row button — same flyout chrome
 * as the project row's ⋯ menu (issue #167). The entry opens the #268
 * terminate-confirm modal (unchanged behavior); the menu drops under its
 * toggle via the `.picker-row-menu-anchor` wrapper, and the outside-click/
 * Escape dismissal (state in use-picker-state) targets toggle + menu
 * together. Pure rendering.
 */
export function RowOptionsMenu(props: {
  sessionId: string;
  /** Whether this row's menu is open. */
  open: boolean;
  /** The terminate request for this row is in flight (entry disabled). */
  pending?: boolean;
  /** The menu entry's label ("Terminate worker…" / "Terminate session…"). */
  entryLabel: string;
  /** The menu entry's explanatory title. */
  entryTitle: string;
  /** Toggles this row's menu (one open row menu at a time). */
  onToggle: () => void;
  /** Opens the terminate-confirm modal for this row (#268). */
  onAskTerminate: () => void;
}) {
  return (
    <div className="picker-row-menu-anchor">
      <button
        type="button"
        className="picker-row-menu-toggle"
        title="Session options"
        aria-haspopup="menu"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        ⋯
      </button>
      {props.open && (
        <div className="picker-context-menu picker-row-menu" role="menu" aria-label="Session options">
          <button
            type="button"
            role="menuitem"
            className="picker-menu-danger"
            title={props.entryTitle}
            disabled={props.pending}
            onClick={props.onAskTerminate}
          >
            {props.entryLabel}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The sidebar's add-project row (issue #259, B7): the former header "+"
 * affordance, now the last row of the sidebar (below the project list),
 * styled like a project row and set apart by a divider. Launches the
 * project onboarding wizard. Pure rendering.
 */
export function AddProjectRow(props: {
  /** Opens the project onboarding wizard. */
  onStartOnboarding: () => void;
}) {
  return (
    <div className="picker-project-row picker-add-row">
      <button
        type="button"
        className="picker-project-name picker-add-name"
        title="Connect a project"
        onClick={props.onStartOnboarding}
      >
        + Add project
      </button>
    </div>
  );
}

/**
 * One worker session row (issue #64): live workers are attachable buttons
 * with a status badge, a live running-time label (issue #182), and a ⋯
 * context menu (issue #355, B5) whose Terminate entry opens the #268
 * confirm modal; archived workers render
 * as plain history (no badge interaction, not attachable, not terminable)
 * with their final run duration frozen at the archive time (issue #182).
 */
export function WorkerRow(props: {
  session: Session;
  workers: Worker[];
  archived: boolean;
  selectedSessionId: string | null;
  pending: boolean;
  /** The ticking client clock for the running-time label (issue #182). */
  now?: number;
  /** Agent-kind sessions spawned by this worker, nested under its row. */
  children?: ReactNode;
  onSelectSession: (sessionId: string) => void;
  onTerminateWorker?: (workerId: string) => void;
  onAskTerminate: (sessionId: string) => void;
  /** Whether this row's ⋯ context menu is open (issue #355, B5). */
  rowMenuOpen?: boolean;
  /** Toggles this row's ⋯ context menu (wired = affordance shown). */
  onToggleRowMenu?: (sessionId: string) => void;
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
          {worker && (
            <span className="picker-runtime picker-runtime-final">
              {formatRunningDuration(worker.startedAt, Date.parse(worker.updatedAt))}
            </span>
          )}
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
        {worker && <span className="picker-runtime">{formatRunningDuration(worker.startedAt, props.now ?? Date.now())}</span>}
        {badge && <span className={badge.className}>{badge.label}</span>}
      </button>
      {props.onTerminateWorker && worker && props.onToggleRowMenu && (
        <RowOptionsMenu
          sessionId={props.session.id}
          open={props.rowMenuOpen === true}
          pending={props.pending}
          entryLabel="Terminate worker…"
          entryTitle="Terminate this worker — the daemon kills the pane and archives it"
          onToggle={() => props.onToggleRowMenu!(props.session.id)}
          onAskTerminate={() => props.onAskTerminate(props.session.id)}
        />
      )}
      {/* Agent-kind sessions spawned by this worker (researcher, docs/
          agent-kinds.md) nest under their caller per the #187 child-group
          pattern — SessionPicker passes them in as a nested list. */}
      {props.children}
    </li>
  );
}

/**
 * One preset-prompt agent-kind session row (docs/agent-kinds.md, issues
 * #297/#300/#302): an attachable button with the kind as its badge (the
 * persona — researcher, devex-audit, kiss-audit — is the identity, not a
 * worker status). Rendered nested under the session that spawned it; shows
 * the spawn's sidebar label (`Session.name`) with the tmux name as fallback,
 * and a ⋯ context menu (issue #355, B5) whose Terminate entry opens the
 * #268 confirm modal (per the #311 affordance, moved off the row).
 */
export function AgentRow(props: {
  session: Session;
  selectedSessionId: string | null;
  /** The terminate request for this row is in flight (entry disabled). */
  pending?: boolean;
  /** Opens the terminate-confirm modal for this agent session (#311). */
  onAskTerminate?: (sessionId: string) => void;
  onSelectSession: (sessionId: string) => void;
  /** Whether this row's ⋯ context menu is open (issue #355, B5). */
  rowMenuOpen?: boolean;
  /** Toggles this row's ⋯ context menu (wired = affordance shown). */
  onToggleRowMenu?: (sessionId: string) => void;
}) {
  return (
    <li className="picker-agent-row">
      <button
        type="button"
        className={`picker-session${props.session.id === props.selectedSessionId ? " selected" : ""}`}
        title={`Attach the ${props.session.agentKind} session's terminal`}
        onClick={() => props.onSelectSession(props.session.id)}
      >
        <span className="role-badge role-agent">{props.session.agentKind}</span>
        <span className="picker-session-name">{props.session.name ?? props.session.tmuxSession}</span>
      </button>
      {props.onAskTerminate && props.onToggleRowMenu && (
        <RowOptionsMenu
          sessionId={props.session.id}
          open={props.rowMenuOpen === true}
          pending={props.pending === true}
          entryLabel="Terminate session…"
          entryTitle="Terminate this agent session — the daemon kills the pane and removes the record"
          onToggle={() => props.onToggleRowMenu!(props.session.id)}
          onAskTerminate={() => props.onAskTerminate!(props.session.id)}
        />
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
  /** The ⋯ menu's spawn-agent submenu is expanded (issue #331). */
  spawnSubmenuOpen: boolean;
  /** The kind registry the submenu renders from (issue #330; shipped fallback). */
  agentKinds: readonly AgentKindSpec[];
  onToggleCollapsed: (projectId: string) => void;
  onToggleMenu: (projectId: string) => void;
  onToggleSpawnSubmenu: (projectId: string) => void;
  onStartOrchestrator: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
} & ProjectMenuCallbacks) {
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
          (#173), so it is not duplicated here. The spawn-agent submenu
          (#331) renders from the live kind registry (issue #330). */}
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
        <ProjectMenu
          projectName={props.projectName}
          projectId={props.projectId}
          agentKinds={props.agentKinds}
          spawnSubmenuOpen={props.spawnSubmenuOpen}
          onToggleSpawnSubmenu={() => props.onToggleSpawnSubmenu(props.projectId)}
          onOpenSettings={props.onOpenSettings}
          onDeleteProject={props.onDeleteProject}
          onSpawnAgent={props.onSpawnAgent}
          onAskSpawnInput={props.onAskSpawnInput}
        />
      )}
    </div>
  );
}

/**
 * The per-project collapsed "Archived" section (issue #64). Pure rendering.
 */
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

/**
 * Issue #354: the desktop collapse toggle — a slim bar at the sidebar's top
 * with a small icon at its right edge (pointing left while open, right while
 * collapsed). Mobile keeps the header hamburger; the CSS hides this bar on
 * the drawer breakpoint. Pure rendering.
 */
export function SidebarToggleBar(props: { open: boolean; onToggle: () => void }) {
  return (
    <div className="picker-topbar">
      <button
        type="button"
        className="sidebar-toggle"
        aria-label={props.open ? "Collapse the sidebar" : "Expand the sidebar"}
        aria-expanded={props.open}
        title="Toggle the sidebar"
        onClick={props.onToggle}
      >
        {props.open ? "‹" : "›"}
      </button>
    </div>
  );
}
