/**
 * Terminal main pane (issue #62): the full-attach xterm pane rendered inside
 * the app shell's main content area. Selecting a session in the sidebar
 * navigates to `/terminal/:sessionId` so terminals are deep-linkable; the
 * sidebar data comes from the shell via context. With no projects at all
 * (first run) the empty state offers the onboarding wizard.
 */

import { useParams } from "react-router";
import { TerminalPane } from "./TerminalPane";
import { useSidebar } from "./sidebar";
import "./terminal.css";

export function TerminalPage() {
  const { sessionId } = useParams();
  const { entries, error, openOnboarding } = useSidebar();

  const selected = entries.flatMap((entry) => entry.sessions).find((session) => session.id === sessionId);

  return (
    <div className="terminal-main">
      {selected ? (
        <TerminalPane key={selected.id} sessionId={selected.id} />
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
