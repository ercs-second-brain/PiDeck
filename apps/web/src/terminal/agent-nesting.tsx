/**
 * Agent-kind session grouping for the terminals sidebar (docs/agent-kinds.md,
 * issues #297/#300/#302): agent sessions nest under their caller per the
 * #187 child-group pattern. A spawn whose parent is a visible
 * non-orchestrator session (typically a worker) renders as a nested child
 * group under that session's row; every other agent session (menu spawns —
 * the orchestrator is their parent by construction — and ones whose caller
 * is not in the project's group) renders at the project's child level, after
 * the workers.
 */

import type { Session, Worker } from "@pideck/shared";
import { AgentRow } from "./picker-rows";

export interface AgentGrouping {
  /** Agent sessions at the project's child level, in session order. */
  rootAgents: Session[];
  /** Agent sessions per caller session id (the caller's row nests them). */
  nestedByParent: Map<string, Session[]>;
}

/** Pure grouping — see the module doc. */
export function splitAgentSessions(sessions: Session[], orchestratorId: string | undefined): AgentGrouping {
  const sessionIds = new Set(sessions.map((session) => session.id));
  const rootAgents: Session[] = [];
  const nestedByParent = new Map<string, Session[]>();
  for (const session of sessions) {
    if (session.agentKind === undefined) continue;
    const parent =
      session.parentSessionId !== undefined &&
      session.parentSessionId !== orchestratorId &&
      sessionIds.has(session.parentSessionId)
        ? session.parentSessionId
        : null;
    if (parent === null) rootAgents.push(session);
    else nestedByParent.set(parent, [...(nestedByParent.get(parent) ?? []), session]);
  }
  return { rootAgents, nestedByParent };
}

/**
 * Worker-session grouping (issue #502): reviewer workers (Worker.kind ===
 * "reviewer", issue #107) nest under the PR-authoring worker's row — same
 * #187 child-group pattern as agent-kind sessions, keyed through the
 * worker records: session → worker → `Worker.parentWorkerId` → parent
 * worker's session. A reviewer whose parent session is not in the group
 * (parent archived, record-less session) renders at the root level so it
 * stays visible; malformed cycles (not producible by the daemon) fall back
 * to root rows instead of vanishing. Pure grouping.
 */
export interface WorkerGrouping {
  /** Worker sessions at the project's child level, in session order. */
  rootWorkers: Session[];
  /** Worker sessions per parent session id (the parent's row nests them). */
  nestedWorkersByParent: Map<string, Session[]>;
}

/**
 * Places one root's whole descendant chain (cycle-safe: only unplaced
 * children whose parent is the node being expanded), session order kept.
 */
function placeDescendants(rootId: string, sessions: Session[], parentOf: Map<string, string>, placed: Set<string>, nestedWorkersByParent: Map<string, Session[]>) {
  const queue = [rootId];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of sessions) {
      if (placed.has(child.id) || parentOf.get(child.id) !== parent) continue;
      placed.add(child.id);
      nestedWorkersByParent.set(parent, [...(nestedWorkersByParent.get(parent) ?? []), child]);
      queue.push(child.id);
    }
  }
}

export function splitWorkerSessions(sessions: Session[], workers: Worker[]): WorkerGrouping {
  const sessionIds = new Set(sessions.map((session) => session.id));
  const parentOf = new Map<string, string>();
  for (const session of sessions) {
    if (session.workerId === null) continue;
    const worker = workers.find((candidate) => candidate.id === session.workerId);
    const parentSessionId = workers.find((candidate) => candidate.id === worker?.parentWorkerId)?.sessionId;
    if (parentSessionId !== undefined && parentSessionId !== session.id && sessionIds.has(parentSessionId)) {
      parentOf.set(session.id, parentSessionId);
    }
  }
  const rootWorkers: Session[] = [];
  const nestedWorkersByParent = new Map<string, Session[]>();
  const placed = new Set<string>();
  for (const session of sessions) {
    if (parentOf.has(session.id)) continue;
    rootWorkers.push(session);
    placed.add(session.id);
    placeDescendants(session.id, sessions, parentOf, placed, nestedWorkersByParent);
  }
  // Cycle fallback: malformed parent chains (not producible by the daemon)
  // render at the root level instead of vanishing.
  for (const session of sessions) {
    if (!placed.has(session.id)) rootWorkers.push(session);
  }
  return { rootWorkers, nestedWorkersByParent };
}

/** The nested child-group under one caller's worker row (no children → nothing). */
export function AgentChildrenList(props: {
  sessions: Session[] | undefined;
  selectedSessionId: string | null;
  /** Session id whose terminate request is in flight (entry disabled, #311). */
  pendingTerminateSessionId?: string | null;
  /** Opens the terminate-confirm modal for an agent session (#311). */
  onAskTerminate?: (sessionId: string) => void;
  onSelectSession: (sessionId: string) => void;
  /** Session id whose row ⋯ menu is open (issue #355, B5). */
  openRowMenuSessionId?: string | null;
  /** Toggles a row's ⋯ context menu (issue #355, B5). */
  onToggleRowMenu?: (sessionId: string) => void;
}) {
  if (props.sessions === undefined || props.sessions.length === 0) return null;
  return (
    <ul className="picker-list picker-agent-children">
      {props.sessions.map((agent) => (
        <AgentRow
          key={agent.id}
          session={agent}
          selectedSessionId={props.selectedSessionId}
          pending={props.pendingTerminateSessionId === agent.id}
          onAskTerminate={props.onAskTerminate}
          onSelectSession={props.onSelectSession}
          rowMenuOpen={props.openRowMenuSessionId === agent.id}
          onToggleRowMenu={props.onToggleRowMenu}
        />
      ))}
    </ul>
  );
}
