/**
 * Terminal page: session picker (every registered project with its
 * orchestrator + worker sessions nested beneath, via the daemon REST API) on
 * the left, the full-attach xterm pane on the right. Selecting a session
 * navigates to `/terminal/:sessionId` so terminals are deep-linkable; the
 * picker refreshes while the page is open. Projects without an orchestrator
 * get a start affordance (issue #53) that brings it up and attaches to it.
 */

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { Worker } from "@agentskiss/shared";
import { fetchProjects, fetchSessions, fetchWorkers, startOrchestrator } from "./api";
import { SessionPicker, type ProjectEntry } from "./SessionPicker";
import { TerminalPane } from "./TerminalPane";
import "./terminal.css";

export function TerminalPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<ProjectEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [startingProjectId, setStartingProjectId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const projects = await fetchProjects();
        const loaded = await Promise.all(
          projects.map(async (project) => {
            const [sessions, workers] = await Promise.all([
              fetchSessions(project.id),
              fetchWorkers(project.id).catch(() => [] as Worker[]),
            ]);
            return { project, sessions, workers };
          }),
        );
        if (!cancelled) {
          setEntries(loaded);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const selected = entries
    .flatMap((entry) => entry.sessions)
    .find((session) => session.id === sessionId);

  /** Starts the project's orchestrator, then attaches to its pane. */
  const handleStartOrchestrator = async (projectId: string) => {
    setStartingProjectId(projectId);
    try {
      const session = await startOrchestrator(projectId);
      navigate(`/terminal/${session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStartingProjectId(null);
    }
  };

  return (
    <main className="terminal-page">
      <SessionPicker
        entries={entries}
        error={error}
        selectedId={sessionId ?? null}
        startingProjectId={startingProjectId}
        onSelect={(id) => navigate(`/terminal/${id}`)}
        onStartOrchestrator={(projectId) => void handleStartOrchestrator(projectId)}
      />
      <section className="terminal-main">
        {selected ? (
          <TerminalPane key={selected.id} sessionId={selected.id} />
        ) : (
          <div className="terminal-placeholder">
            <p>Select a session to attach.</p>
            <p className="terminal-hint">
              Terminals are live tmux sessions — they keep running when you disconnect.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
