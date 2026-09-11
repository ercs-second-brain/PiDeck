/**
 * Worker-row assembly for the terminals sidebar (issues #63/#64/#107/#502):
 * computes one project's worker layout — the live/archived split, the
 * agent-kind grouping (splitAgentSessions), and the reviewer nesting
 * (splitWorkerSessions, issue #502) — and renders one worker row with its
 * nested spawns. Kept in a module of its own so SessionPicker's
 * ProjectSection stays within the repo's function-size budget.
 */

import type { Session, Worker } from "@pideck/shared";
import { workerFor, WorkerRow } from "./picker-rows";
import { AgentChildrenList, splitAgentSessions, splitWorkerSessions } from "./agent-nesting";

/** Props of {@link workerRowWithAgents} — everything one worker row needs. */
export type WorkerRowBag = {
  workers: Worker[];
  selectedSessionId: string | null;
  pendingTerminateWorkerId: string | null;
  /** Agent-kind session whose terminate request is in flight (#311). */
  pendingTerminateSessionId: string | null;
  now: number;
  nestedByParent: Map<string, Session[]>;
  /** Reviewer worker sessions per parent session id (issue #502 nesting). */
  nestedWorkersByParent: Map<string, Session[]>;
  onSelectSession: (sessionId: string) => void;
  onTerminateWorker?: (workerId: string) => Promise<void>;
  onAskTerminate: (sessionId: string) => void;
  /** Present only when a terminate handler is wired (undefined hides the ⋯). */
  agentAskTerminate: ((sessionId: string) => void) | undefined;
  /** Session id whose row ⋯ context menu is open (issue #355, B5). */
  openRowMenuSessionId: string | null;
  onToggleRowMenu: (sessionId: string) => void;
};

/**
 * One live/archived worker row, with its nested spawns (if any). Agent-kind
 * sessions nest via `nestedByParent`; reviewer workers nest under the
 * PR-authoring worker via `nestedWorkersByParent` (issue #502), recursively
 * so a reviewer's own agent spawns (and any deeper chains) keep their
 * nesting.
 */
export function workerRowWithAgents(bag: WorkerRowBag, session: Session, archived: boolean) {
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
      rowMenuOpen={bag.openRowMenuSessionId === session.id}
      onToggleRowMenu={bag.onToggleRowMenu}
    >
      {!archived && (
        <>
          <AgentChildrenList
            sessions={bag.nestedByParent.get(session.id)}
            selectedSessionId={bag.selectedSessionId}
            pendingTerminateSessionId={bag.pendingTerminateSessionId}
            onAskTerminate={bag.agentAskTerminate}
            onSelectSession={bag.onSelectSession}
            openRowMenuSessionId={bag.openRowMenuSessionId}
            onToggleRowMenu={bag.onToggleRowMenu}
          />
          {/* Reviewer workers spawned for this worker's PR (issue #107/#502)
              nest under its row with the same #187 child-group pattern. */}
          {bag.nestedWorkersByParent.get(session.id)?.length ? (
            <ul className="picker-list picker-agent-children">
              {bag.nestedWorkersByParent.get(session.id)!.map((child) => workerRowWithAgents(bag, child, false))}
            </ul>
          ) : null}
        </>
      )}
    </WorkerRow>
  );
}

/**
 * The section props {@link projectWorkerLayout} reads — the slice of
 * ProjectSection's props it needs (structurally satisfied by ProjectSection;
 * kept here to avoid an import cycle).
 */
export interface WorkerLayoutSource {
  selectedSessionId: string | null;
  pendingTerminateWorkerId: string | null;
  pendingTerminateSessionId: string | null;
  now: number;
  onSelectSession: (sessionId: string) => void;
  onTerminateWorker?: (workerId: string) => Promise<void>;
  onAskTerminate: (sessionId: string) => void;
  onTerminateAgentSession?: (sessionId: string) => Promise<void>;
  openRowMenuSessionId: string | null;
  onToggleRowMenu: (sessionId: string) => void;
}

/** One project's worker layout: the row lists + the shared render bag. */
export interface ProjectWorkerLayout {
  /** Live worker sessions (all of them — the render loop uses rootWorkers). */
  activeWorkers: Session[];
  /** Archived worker sessions (the collapsed Archived section, flat). */
  archivedWorkers: Session[];
  /** Live worker rows to render; nested reviewers hang off their parents. */
  rootWorkers: Session[];
  /** Agent-kind sessions at the project's child level (#187 pattern). */
  rootAgents: Session[];
  /** The shared per-row render bag (worker records + interaction state). */
  bag: WorkerRowBag;
}

/**
 * Computes one project's worker layout from its sidebar entry plus the
 * interaction-state slice of the section props. Pure — no rendering.
 */
export function projectWorkerLayout(entry: { sessions: Session[]; workers: Worker[] }, props: WorkerLayoutSource): ProjectWorkerLayout {
  const { sessions, workers } = entry;
  const orchestrator = sessions.find((session) => session.role === "orchestrator");
  // Issue #316: agent-kind sessions carry role "worker" (they are sessions,
  // never worker records) — they render only through the agent-row grouping
  // below (splitAgentSessions); selection keys on the shared session id.
  const workerSessions = sessions.filter((session) => session.role === "worker" && session.agentKind === undefined);
  // Issue #64: terminated workers move to the collapsed archived section — only live ones render under the row.
  const activeWorkers = workerSessions.filter((session) => workerFor(session, workers)?.status !== "archived");
  const archivedWorkers = workerSessions.filter((session) => workerFor(session, workers)?.status === "archived");
  // Agent-kind sessions nest under their caller (#187 pattern) — see agent-nesting.ts.
  const { rootAgents, nestedByParent } = splitAgentSessions(sessions, orchestrator?.id);
  // Reviewer workers nest under the PR-authoring worker's row (issue #502);
  // computed over the live workers only — an archived parent drops the
  // reviewer to the root level, and the archived section stays flat.
  const { rootWorkers, nestedWorkersByParent } = splitWorkerSessions(activeWorkers, workers);
  const bag: WorkerRowBag = {
    workers, selectedSessionId: props.selectedSessionId,
    pendingTerminateWorkerId: props.pendingTerminateWorkerId, pendingTerminateSessionId: props.pendingTerminateSessionId,
    now: props.now, nestedByParent, nestedWorkersByParent, onSelectSession: props.onSelectSession,
    onTerminateWorker: props.onTerminateWorker, onAskTerminate: props.onAskTerminate,
    agentAskTerminate: props.onTerminateAgentSession !== undefined ? props.onAskTerminate : undefined,
    openRowMenuSessionId: props.openRowMenuSessionId, onToggleRowMenu: props.onToggleRowMenu,
  };
  return { activeWorkers, archivedWorkers, rootWorkers, rootAgents, bag };
}