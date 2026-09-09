/**
 * Sidebar for the terminals page — the app's only navigation (issue #62):
 * the "Workspace" row (issue #259, the renamed global-agent entry —
 * display only; the daemon's reserved `global` id and API are unchanged)
 * sits above every project: its NAME opens the all-projects (workspace)
 * board and its chat icon attaches/starts the workspace-level agent
 * (idempotent ensure endpoint, #53); the row is disabled until at least
 * one project exists (#259, B3) — with nothing to orchestrate there is no
 * workspace work to open. Every registered project is a top-level entry
 * whose NAME opens that
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
 * worker and a live running-time label ticking every second (issue
 * #182; archived rows freeze their final run duration). Each project row
 * also carries a ⋯ context menu (issue #167) whose
 * Settings entry opens that project's settings page in the main pane.
 * At the bottom of the sidebar, an "+ Add project" row (issue #259, the
 * former header "+") launches the project onboarding wizard. A persistent
 * footer pinned to the sidebar's bottom (issue #176) opens the global
 * settings page (worker pipeline, notifications, pi auth) in the main
 * pane — visible regardless of scroll, collapse state, or project-list
 * errors, including in the mobile drawer. Interaction state lives in
 * this component (which worker is confirming termination, which projects'
 * archived sections are expanded, which projects are collapsed); the pure
 * view pieces live in {@link ./picker-rows.tsx}.
 */

import { useState, type ReactNode } from "react";
import type { AgentKind, Project, Session, Worker } from "@pideck/shared";
import {
  AddProjectRow,
  AgentRow,
  ArchivedSection,
  ProjectRow,
  WorkerRow,
  workerFor,
} from "./picker-rows";
import { ConfirmModals } from "./picker-confirms";
import { AgentChildrenList, splitAgentSessions } from "./agent-nesting";
import { GlobalAgentRow } from "./GlobalAgentRow";
import { usePickerState } from "./use-picker-state";
import { useTickingNow } from "./use-ticking-now";

export interface ProjectEntry {
  project: Project;
  sessions: Session[];
  workers: Worker[];
}

/** Props of {@link workerRowWithAgents} — everything one worker row needs. */
type WorkerRowBag = {
  workers: Worker[];
  selectedSessionId: string | null;
  pendingTerminateWorkerId: string | null;
  /** Agent-kind session whose terminate request is in flight (#311). */
  pendingTerminateSessionId: string | null;
  now: number;
  nestedByParent: Map<string, Session[]>;
  onSelectSession: (sessionId: string) => void;
  onTerminateWorker?: (workerId: string) => Promise<void>;
  onAskTerminate: (sessionId: string) => void;
  /** Present only when a terminate handler is wired (undefined hides the ✕). */
  agentAskTerminate: ((sessionId: string) => void) | undefined;
};

/** One live/archived worker row, with its nested agent-kind spawns (if any) — module-level so ProjectSection stays within budget. */
function workerRowWithAgents(bag: WorkerRowBag, session: Session, archived: boolean) {
  const worker = workerFor(session, bag.workers);
  return (
    <WorkerRow
      key={session.id}
      session={session}
      workers={bag.workers}
      archived={archived}
      selectedSessionId={bag.selectedSessionId}
      pending={worker !== undefined && bag.pendingTerminateWorkerId === worker.id}
      now={bag.now}
      onSelectSession={bag.onSelectSession}
      onTerminateWorker={bag.onTerminateWorker}
      onAskTerminate={bag.onAskTerminate}
    >
      {!archived && (
        <AgentChildrenList
          sessions={bag.nestedByParent.get(session.id)}
          selectedSessionId={bag.selectedSessionId}
          pendingTerminateSessionId={bag.pendingTerminateSessionId}
          onAskTerminate={bag.agentAskTerminate}
          onSelectSession={bag.onSelectSession}
        />
      )}
    </WorkerRow>
  );
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
  /** The ticking client clock for workers' running-time labels (issue #182). */
  now: number;
  /** Worker id whose termination request is in flight (issue #64). */
  pendingTerminateWorkerId: string | null;
  /** Agent-kind session whose termination request is in flight (issue #311). */
  pendingTerminateSessionId: string | null;
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
  /** Opens the delete-confirmation modal (issue #172). */
  onAskDeleteProject: (projectId: string) => void;
  onToggleMenu: (projectId: string) => void;
  onStartOrchestrator: (projectId: string) => void;
  /** Spawns an audit agent-kind session (docs/agent-kinds.md, #300/#302). */
  onSpawnAgent: (projectId: string, kind: AgentKind) => void;
  /** Opens the question modal for a kind whose shared spec takesInput (#297, #324). */
  onAskSpawnInput: (projectId: string, kind: AgentKind) => void;
  /** Terminate-after-confirm handlers (worker #268; agent-kind session #311). */
  onTerminateWorker?: (workerId: string) => Promise<void>;
  onTerminateAgentSession?: (sessionId: string) => Promise<void>;
  /** Opens the terminate-confirmation modal on a session row (issue #64/#116/#311). */
  onAskTerminate: (sessionId: string) => void;
}) {
  const { project, sessions, workers } = props.entry;
  const orchestrator = sessions.find((session) => session.role === "orchestrator");
  // Issue #316: agent-kind sessions carry role "worker" (they are sessions,
  // never worker records) — they render only through the agent-row grouping
  // below (splitAgentSessions). Including them here drew a ghost "worker"
  // row per persona, and since selection keys on the shared session id, both
  // rows highlighted together.
  const workerSessions = sessions.filter((session) => session.role === "worker" && session.agentKind === undefined);
  // Issue #64: terminated workers move to the collapsed archived section;
  // only live workers render under the project row.
  const activeWorkers = workerSessions.filter((session) => workerFor(session, workers)?.status !== "archived");
  const archivedWorkers = workerSessions.filter((session) => workerFor(session, workers)?.status === "archived");
  const starting = props.startingProjectId === project.id;

  // Agent-kind sessions nest under their caller (#187 pattern) — see agent-nesting.ts.
  const { rootAgents, nestedByParent } = splitAgentSessions(sessions, orchestrator?.id);
  const bag: WorkerRowBag = {
    workers, selectedSessionId: props.selectedSessionId,
    pendingTerminateWorkerId: props.pendingTerminateWorkerId, pendingTerminateSessionId: props.pendingTerminateSessionId,
    now: props.now, nestedByParent, onSelectSession: props.onSelectSession,
    onTerminateWorker: props.onTerminateWorker, onAskTerminate: props.onAskTerminate,
    agentAskTerminate: props.onTerminateAgentSession !== undefined ? props.onAskTerminate : undefined,
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
        onDeleteProject={(projectId) => {
          props.onAskDeleteProject(projectId);
        }}
        onSpawnAgent={props.onSpawnAgent}
        onAskSpawnInput={props.onAskSpawnInput}
      />
      {!props.collapsed && (activeWorkers.length > 0 || rootAgents.length > 0) && (
        <ul className="picker-list picker-workers">
          {activeWorkers.map((session) => workerRowWithAgents(bag, session, false))}
          {rootAgents.map((agent) => (
            <AgentRow key={agent.id} session={agent} selectedSessionId={props.selectedSessionId} pending={props.pendingTerminateSessionId === agent.id} onAskTerminate={bag.agentAskTerminate} onSelectSession={props.onSelectSession} />
          ))}
        </ul>
      )}
      {!props.collapsed && archivedWorkers.length > 0 && (
        <ArchivedSection projectId={project.id} count={archivedWorkers.length} open={props.archivedOpen} onToggle={props.onToggleArchived} rows={archivedWorkers.map((session) => workerRowWithAgents(bag, session, true))} />
      )}
    </section>
  );
}

export interface SessionPickerProps {
  entries: ProjectEntry[];
  error: string | null;
  /** Project list still loading (issue #90): empty ≠ no projects yet. */
  loading?: boolean;
  selectedSessionId: string | null;
  selectedProjectId?: string | null;
  startingProjectId?: string | null;
  /** The workspace-level global agent session, when one exists. */
  globalAgent?: Session | null;
  /** True while the global agent start request is in flight. */
  startingGlobalAgent?: boolean;
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
  /** The all-projects (workspace) board is open in the main pane (selects the Workspace row's name, #259). */
  allProjectsSelected?: boolean;
  /** Opens the all-projects (workspace) board (the Workspace row's name, #259). */
  onSelectAllProjects: () => void;
  /** Opens the global settings page in the main pane (the sidebar footer, #176). */
  onOpenGlobalSettings: () => void;
  /** Opens the agent-assets editor (per-persona prompts & skills) over the current view (issue #315). */
  onOpenAgentAssets?: () => void;
  /** Opens the project onboarding wizard (the "+ Add project" row, #259). */
  onStartOnboarding: () => void;
  /**
   * Spawns a preset-prompt agent-kind session (docs/agent-kinds.md, issues
   * #297/#300/#302): the researcher carries its question, the audit
   * kinds take none. Reloads and navigates to the new session's terminal.
   * Rejects so the researcher modal owns the error.
   */
  onSpawnAgentSession?: (projectId: string, kind: AgentKind, question?: string) => Promise<void>;
  /**
   * Terminates an agent-kind session (issue #311): the daemon kills the
   * pane and removes the record; refreshes so the row disappears. Rejects
   * so the terminate modal owns the error (#268 lifecycle).
   */
  onTerminateAgentSession?: (sessionId: string) => Promise<void>;
  /** Starts (or attaches to) the project's orchestrator — the chat-icon click (#173, #53). */
  onStartOrchestrator: (projectId: string) => void;
  /** Starts (or attaches to) the workspace-level global agent. */
  onStartGlobalAgent?: () => void;
  /** Deletes a project locally (issue #172): daemon teardown, GitHub repo
   * kept. Rejecting (e.g. 409 while workers drive a PR) surfaces in the modal. */
  onDeleteProject?: (projectId: string) => Promise<void>;
  /** Terminates a worker after its confirmation (issue #268: awaited by the modal). */
  onTerminateWorker?: (workerId: string) => Promise<void>;
  /** Issue #260 (B8): compact update popup rendered inside the footer,
   * anchored above the settings entry. Quiet when up to date / loading. */
  updateSlot?: ReactNode;
}

/**
 * The sidebar's sticky footer (issue #176): the agent-assets entry above the
 * settings entry (issue #315 — the same quiet footer chrome, one group), plus
 * the #260 update-popup slot. Pinned to the bottom; visible regardless of
 * project-list state.
 */
function PickerFooter(props: { updateSlot?: ReactNode; onOpenAgentAssets?: () => void; onOpenGlobalSettings: () => void }) {
  return (
    <div className="picker-footer">
      {/* Issue #260 (B8): the update popup anchors above the settings
          entry — the sticky footer is its containing block. */}
      {props.updateSlot}
      <button
        type="button"
        className="picker-footer-agent-assets"
        title="Agent assets — per-persona prompts & skills"
        onClick={props.onOpenAgentAssets}
      >
        ✎ Prompts & skills
      </button>
      <button
        type="button"
        className="picker-footer-settings"
        title="Global settings — worker pipeline, notifications, pi auth"
        onClick={props.onOpenGlobalSettings}
      >
        ⚙ Settings
      </button>
    </div>
  );
}

/** Sidebar: project name opens the board, chat icon the orchestrator (#173), workers nested beneath. */
export function SessionPicker(props: SessionPickerProps) {
  const state = usePickerState(props.entries, props.terminatingWorkerId ?? null, props.defaultArchivedOpen === true, props.defaultCollapsedProjects);
  const now = useTickingNow();
  // Issues #297/#300/#302: direct audit spawns from the ⋯ menu (no modal —
  // their persona is the whole prompt). A rejected spawn (daemon unreachable,
  // kind plumbing not live yet) surfaces above the footer, like the
  // daemon-unreachable error.
  const [spawnError, setSpawnError] = useState<string | null>(null);
  // Issue #311: in-flight ✕ overlay targets the confirming agent session.
  const pendingAgentTerminateId =
    state.pendingTerminate && state.confirmingSession?.agentKind !== undefined ? state.confirmingSessionId : null;
  const spawnAgent = (projectId: string, kind: AgentKind, question?: string) => {
    if (props.onSpawnAgentSession === undefined) return;
    setSpawnError(null);
    props.onSpawnAgentSession(projectId, kind, question).catch((err: unknown) =>
      setSpawnError(err instanceof Error ? err.message : String(err)),
    );
  };

  return (
    <aside className="session-picker">
      {/* Issue #327: the project list scrolls inside its own region — the
          footer lives outside the scroll container, so its full-width
          buttons span the sidebar's whole visible width (a scrollbar inside
          the old all-scrolling sidebar shifted the footer — and the
          settings button — left of the sidebar's visual center). */}
      <div className="picker-scroll">
        {/* Issue #259: the Workspace row (renamed global-agent entry) — name
            opens the all-projects board, chat attaches/starts the workspace
            agent; disabled until at least one project exists (B3). */}
        <GlobalAgentRow
          session={props.globalAgent ?? null}
          selected={props.globalAgent?.id === props.selectedSessionId}
          boardSelected={props.allProjectsSelected === true}
          disabled={props.entries.length === 0}
          starting={props.startingGlobalAgent === true}
          onSelectBoard={props.onSelectAllProjects}
          onStart={() => props.onStartGlobalAgent?.()}
        />
        {props.entries.map((entry) => (
          <ProjectSection
            key={entry.project.id} entry={entry}
            selectedSessionId={props.selectedSessionId} selectedProjectId={props.selectedProjectId ?? null}
            startingProjectId={props.startingProjectId ?? null} confirmingSessionId={state.confirmingSessionId}
            openMenuProjectId={state.openMenuId} now={now}
            pendingTerminateWorkerId={props.terminatingWorkerId ?? null} pendingTerminateSessionId={pendingAgentTerminateId}
            archivedOpen={state.archivedOpen.has(entry.project.id)} onToggleArchived={state.toggleArchived}
            collapsed={state.collapsedProjects.has(entry.project.id)} onToggleCollapsed={state.toggleCollapsed}
            onSelectSession={props.onSelectSession} onSelectProject={props.onSelectProject}
            onOpenSettings={(projectId) => {
              state.closeMenu();
              props.onOpenSettings(projectId);
            }}
            onAskDeleteProject={(projectId) => {
              state.closeMenu();
              state.deleteConfirm.ask(projectId);
            }}
            onToggleMenu={state.toggleMenu} onStartOrchestrator={props.onStartOrchestrator}
            onSpawnAgent={(projectId, kind) => {
              state.closeMenu();
              spawnAgent(projectId, kind);
            }}
            onAskSpawnInput={(projectId, kind) => {
              state.closeMenu();
              setSpawnError(null);
              state.researcherAsk.ask(projectId, kind);
            }}
            onTerminateWorker={props.onTerminateWorker} onTerminateAgentSession={props.onTerminateAgentSession}
            onAskTerminate={state.askTerminate}
          />
        ))}
        <ConfirmModals
          state={state}
          entries={props.entries}
          onTerminateWorker={props.onTerminateWorker}
          onTerminateAgentSession={props.onTerminateAgentSession}
          onSpawnAgentSession={props.onSpawnAgentSession}
          onDeleteProject={props.onDeleteProject}
        />
        {props.entries.length === 0 && !props.error && (
          <p className="picker-empty">{props.loading ? "Loading projects…" : "No projects yet — add one below to get started."}</p>
        )}
        {props.error && <p className="picker-error">Daemon unreachable: {props.error}</p>}
        {spawnError && <p className="picker-error">Spawn failed: {spawnError}</p>}
        {/* Issue #259 (B7): the add-project affordance as the sidebar's
            bottom row, styled like a project row (the former header "+"). */}
        <AddProjectRow onStartOnboarding={props.onStartOnboarding} />
      </div>
      <PickerFooter updateSlot={props.updateSlot} onOpenAgentAssets={props.onOpenAgentAssets} onOpenGlobalSettings={props.onOpenGlobalSettings} />
    </aside>
  );
}
