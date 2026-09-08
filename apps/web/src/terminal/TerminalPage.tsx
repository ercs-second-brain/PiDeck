/**
 * Terminal main pane (issue #62): the full-attach xterm pane rendered inside
 * the app shell's main content area. Selecting a session in the sidebar
 * navigates to `/terminal/:sessionId` so terminals are deep-linkable; the
 * sidebar data comes from the shell via context. With no projects at all
 * (first run) the empty state offers the onboarding wizard.
 *
 * Issue #104: selecting an **archived** worker's session renders the
 * read-only archived log (captured scrollback + final metadata) instead of
 * a dead terminal pane.
 */

import { useParams } from "react-router";
import type { Session } from "@pideck/shared";
import { TerminalPane } from "./TerminalPane";
import { ArchivedLogView } from "./ArchivedLogView";
import type { ProjectEntry } from "./SessionPicker";
import { useSidebar } from "./sidebar";
import "./terminal.css";

/**
 * The session behind the route param: a project entry's session, or — for
 * the workspace-level global agent (projectId `global`, which belongs to no
 * project entry) — the sidebar context's global agent session.
 */
function findSelectedSession(
  entries: ProjectEntry[],
  globalAgent: Session | null,
  sessionId: string | undefined,
): Session | undefined {
  if (sessionId === undefined) return undefined;
  for (const entry of entries) {
    const session = entry.sessions.find((candidate) => candidate.id === sessionId);
    if (session !== undefined) return session;
  }
  return globalAgent !== null && globalAgent.id === sessionId ? globalAgent : undefined;
}

export function TerminalPage() {
  const { sessionId } = useParams();
  const { entries, globalAgent, error, loaded, openOnboarding } = useSidebar();

  const selected = findSelectedSession(entries, globalAgent, sessionId);
  const selectedWorker =
    selected?.workerId != null ? entries.flatMap((entry) => entry.workers).find((worker) => worker.id === selected.workerId) : undefined;
  const prUrl = selected ? entries.find((entry) => entry.project.id === selected.projectId)?.project.repoUrl : undefined;

  return (
    <div className="terminal-main">
      {selected && selectedWorker?.status === "archived" ? (
        <ArchivedLogView workerId={selectedWorker.id} prUrl={prUrl ?? null} />
      ) : selected ? (
        <TerminalPane key={selected.id} sessionId={selected.id} />
      ) : !loaded && !error ? (
        // Issue #90: not-loaded ≠ no-projects — don't offer onboarding while
        // the project list is still in flight.
        <div className="terminal-placeholder">
          <p>Loading projects…</p>
        </div>
      ) : entries.length === 0 && !error ? (
        <div className="terminal-placeholder">
          <p>No projects connected yet.</p>
          <button type="button" className="button button-primary" onClick={openOnboarding}>
            Connect your first project
          </button>
          <p className="terminal-hint">Onboarding checks pi/gh auth, connects a repo, and registers the project.</p>
        </div>
      ) : (
        <div className="terminal-placeholder">
          <p>Select a session to attach.</p>
          <p className="terminal-hint">
            Terminals are live tmux sessions — they keep running when you disconnect.
          </p>
        </div>
      )}
    </div>
  );
}
