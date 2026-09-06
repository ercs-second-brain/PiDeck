import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { BoardColumn } from "../components/BoardColumn";
import { WorkersPanel } from "../components/WorkersPanel";
import { boardStore, useAppState } from "../store/store";

const CONNECTION_LABELS = {
  connecting: "connecting…",
  online: "live",
  offline: "reconnecting…",
} as const;

/** Kanban board page for one project — live daemon data (REST + websocket). */
export function BoardPage() {
  const { projectId } = useParams();
  const state = useAppState();

  useEffect(() => {
    if (projectId === undefined) return;
    // A 404 here usually means the project was just registered and the local
    // project list is stale — refresh it so the board appears without waiting
    // for the next poll.
    void boardStore.loadProject(projectId).catch(() => boardStore.refresh());
  }, [projectId]);

  const project = state.projects.find((p) => p.id === projectId);
  if (projectId === undefined || project === undefined) {
    return (
      <main className="page">
        <p className="empty">{state.loaded ? `Project “${projectId ?? "?"}” not found.` : "Loading…"}</p>
        <Link to="/" className="back-link">
          ← All projects
        </Link>
      </main>
    );
  }

  const board = state.boards[project.id];
  const workers = state.workers[project.id] ?? [];
  const pullRequests = state.pullRequests[project.id] ?? [];
  const details = { pullRequests: new Map(pullRequests.map((pr) => [pr.number, pr])) };

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
          <span className={`connection connection-${state.connection}`} title="WebSocket connection to the daemon">
            <span className="connection-dot" /> {CONNECTION_LABELS[state.connection]}
          </span>
          <Link className="button" to={`/projects/${project.id}/settings`}>
            Settings
          </Link>
        </div>
      </div>

      {state.loadError !== null && <p className="error-note">Daemon unreachable: {state.loadError}</p>}
      {board === undefined ? (
        <p className="empty">Loading board…</p>
      ) : (
        <div className="board">
          {board.columns.map((column) => (
            <BoardColumn key={column.column} summary={column} details={details} />
          ))}
        </div>
      )}

      <WorkersPanel projectId={project.id} workers={workers} />

      <Link to="/" className="back-link">
        ← All projects
      </Link>
    </main>
  );
}
