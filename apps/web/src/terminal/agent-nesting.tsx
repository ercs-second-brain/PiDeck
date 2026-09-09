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

import type { Session } from "@pideck/shared";
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

/** The nested child-group under one caller's worker row (no children → nothing). */
export function AgentChildrenList(props: {
  sessions: Session[] | undefined;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
}) {
  if (props.sessions === undefined || props.sessions.length === 0) return null;
  return (
    <ul className="picker-list picker-agent-children">
      {props.sessions.map((agent) => (
        <AgentRow key={agent.id} session={agent} selectedSessionId={props.selectedSessionId} onSelectSession={props.onSelectSession} />
      ))}
    </ul>
  );
}
