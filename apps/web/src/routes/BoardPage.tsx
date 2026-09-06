import { Link, useParams } from "react-router";
import { deriveBoard } from "../lib/kanban";
import { BoardColumn } from "../components/BoardColumn";
import { boardStore, useAppState } from "../store/store";

/** Kanban board page for one project. */
export function BoardPage() {
  const { projectId } = useParams();
  const state = useAppState();

  const project = state.projects.find((p) => p.id === projectId);
  if (!project) {
    return (
      <main className="page">
        <p className="empty">Project “{projectId}” not found.</p>
        <Link to="/" className="back-link">
          ← All projects
        </Link>
      </main>
    );
  }

  const board = deriveBoard(project, state.issues, state.pullRequests, state.workers);

  const details = {
    issues: new Map(state.issues.filter((i) => i.projectId === project.id).map((i) => [i.number, i])),
    pullRequests: new Map(
      state.pullRequests.filter((pr) => pr.projectId === project.id).map((pr) => [pr.number, pr]),
    ),
  };

  return (
    <main className="page page-wide">
      <div className="board-header">
        <div>
          <h1 className="page-title">{project.name}</h1>
          <span className="project-repo">{project.repoUrl}</span>
        </div>
        <button
          type="button"
          className="simulate-button"
          onClick={() => boardStore.simulateStateChange()}
          title="Mock action: advance one entity through its lifecycle (replaced by live updates in #13)"
        >
          Simulate state change
        </button>
      </div>
      <div className="board">
        {board.columns.map((column) => (
          <BoardColumn key={column.column} summary={column} details={details} />
        ))}
      </div>
      <Link to="/" className="back-link">
        ← All projects
      </Link>
    </main>
  );
}
