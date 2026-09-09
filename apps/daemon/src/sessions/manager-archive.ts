/**
 * Persona-agent archive mechanics (issue #357 B9/B10): the session-record
 * twin of the worker archive (#64). An agent-kind session terminated from
 * the webapp is **archived**, not deleted — the registry record is kept
 * with `Session.archivedAt` and the pane scrollback is captured at
 * termination (the #104 pattern), keyed by session id in the same archived-
 * log store as the worker captures.
 *
 * Split from `manager.ts` (kiss max-lines budget) following the
 * `agent-kind-spawn.ts` pattern: explicit deps, free function; the
 * {@link SessionManager} facade delegates.
 */

import type { Session } from "@pideck/shared";

import { ARCHIVED_SCROLLBACK_LINES, type ArchivedLogStore } from "./archived-logs.js";
import type { SessionRegistry } from "./registry.js";
import type { Tmux } from "./tmux.js";

/** The collaborators the archive path works over. */
export interface AgentArchiveDeps {
  tmux: Tmux;
  registry: SessionRegistry;
  archivedLogs: ArchivedLogStore;
}

/**
 * Archives a persona agent session: kills its tmux pane, captures the
 * scrollback at termination, and marks the registry record `archivedAt`
 * instead of deleting it. Archived persona agents behave like archived
 * workers: excluded from live listings, never resurrected by reconcile,
 * never relaunchable (their history is the archived log).
 *
 * Cascades (issue #357 B10): every **live descendant agent-kind session**
 * (the parentSessionId lineage — children, grandchildren, …) is archived
 * with it; child panes get the same kill + capture + mark treatment.
 *
 * Idempotent and safe on already-dead panes (a missing tmux session is not
 * an error; a capture failure never blocks the terminate). Re-archiving an
 * already-archived session refreshes nothing and returns the record.
 * Returns `null` for an unknown id. Non-agent-kind sessions keep the
 * killSession semantics via the caller's callback (this path is persona
 * agents only).
 */
export async function archiveAgentSession(
  deps: AgentArchiveDeps,
  sessionId: string,
  killSession: (sessionId: string) => Promise<Session | null>,
): Promise<Session | null> {
  const session = deps.registry.getSession(sessionId);
  if (!session) return null;
  if (session.agentKind === undefined) return killSession(sessionId);
  await archiveAgentPane(deps, session);
  // B10 cascade: breadth-first over the parent lineage, so grandchildren
  // archive even when a child died mid-way (each child is marked before
  // its own descendants are discovered).
  const frontier: string[] = [session.id];
  while (frontier.length > 0) {
    const parentId = frontier.shift() as string;
    for (const child of deps.registry.listSessions()) {
      if (child.agentKind === undefined || child.archivedAt !== undefined) continue;
      if (child.parentSessionId !== parentId) continue;
      await archiveAgentPane(deps, child);
      frontier.push(child.id);
    }
  }
  return deps.registry.getSession(session.id) as Session;
}

/** One persona agent's archive step: capture scrollback, kill pane, mark `archivedAt`. */
async function archiveAgentPane(deps: AgentArchiveDeps, session: Session): Promise<void> {
  if (await deps.tmux.hasSession(session.tmuxSession)) {
    // The #104 pattern: capture the scrollback BEFORE killing the pane —
    // the bytes at termination. A capture failure never blocks the archive.
    try {
      const scrollback = await deps.tmux.capturePane(session.tmuxSession, {
        lines: ARCHIVED_SCROLLBACK_LINES,
      });
      deps.archivedLogs.save(session.id, { capturedAt: new Date().toISOString(), scrollback });
    } catch (err) {
      console.error(`[sessions] scrollback capture failed for ${session.tmuxSession}:`, err);
    }
    await deps.tmux.killSession(session.tmuxSession);
  }
  deps.registry.markSessionArchived(session.id, new Date().toISOString());
}
