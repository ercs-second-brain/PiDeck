import { Link, useParams } from "react-router";
import { BoardColumns, mergedCardDetails } from "../components/BoardColumns";
import { WorkersPanel } from "../components/WorkersPanel";
import { useProject } from "../lib/use-project";
import { useAppState } from "../store/store";

/**
 * Kanban board for one project (issue #62) — rendered in the app shell's
 * main pane (the sidebar stays); live daemon data (REST + websocket).
 */
export function BoardPage() {
  const { projectId } = useParams();
  const { project, fallback } = useProject(projectId);
  const state = useAppState();
  if (project === undefined) return fallback;

  const board = state.boards[project.id];
  const workers = state.workers[project.id] ?? [];

  return (
    <main className="page page-wide">
      <div className="board-header">
        <div>
          <h1 className="page-title">{project.name}</h1>
          <span className="project-repo">
            {project.repoUrl} · branch <code>{project.defaultBranch}</code>
            {project.settings.autoAgentUsername && (
              <span className="project-auto"> · auto-spawn @{project.settings.autoAgentUsername}</span>
            )}
          </span>
        </div>
        <div className="board-actions">
          {/* Issue #276: the live indicator is removed from the kanban — the
              sidebar's own daemon status covers connectivity. Also issue
              #175: no Settings button here — the project row's ⋯ menu (#167)
              is the single path to the settings page. */}
        </div>
      </div>

      {state.loadError !== null && <p className="error-note">Daemon unreachable: {state.loadError}</p>}
      {board === undefined ? (
        <p className="empty">Loading board…</p>
      ) : (
        <BoardColumns boards={[board]} details={mergedCardDetails([board], state.pullRequests)} />
      )}

      <WorkersPanel projectId={project.id} workers={workers} />

      <Link to="/" className="back-link">
        ← All projects
      </Link>
    </main>
  );
}
