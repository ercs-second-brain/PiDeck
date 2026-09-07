import { useEffect } from "react";
import type { KanbanBoard } from "@agentskiss/shared";
import { BoardColumns, mergedCardDetails } from "../components/BoardColumns";
import { WorkersPanel } from "../components/WorkersPanel";
import { boardStore, useAppState } from "../store/store";
import { ConnectionIndicator } from "./BoardPage";
import { useSidebar } from "../terminal/sidebar";

/**
 * All-projects combined kanban board (issue #62) — opened by clicking the
 * sidebar's "Projects" header. Every loaded project's board is merged into
 * one column set; workers are listed per project beneath it. With no
 * projects registered (first run) it shows the onboarding entry point.
 */
export function AllProjectsBoard() {
  const state = useAppState();
  const { openOnboarding } = useSidebar();

  const projectIds = state.projects.map((p) => p.id).join(",");
  useEffect(() => {
    // Load each project's board once when the project set changes (#88: the
    // store's loadProject is single-flight, and depending on the boards map
    // here would re-issue loads on every board/websocket state change).
    for (const id of projectIds.split(",").filter(Boolean)) {
      if (boardStore.getState().boards[id] === undefined) {
        void boardStore.loadProject(id).catch(() => boardStore.refresh());
      }
    }
    // Board data flows in via the store's websocket/poll, not via this effect.
  }, [projectIds]);

  if (state.projects.length === 0) {
    if (!state.loaded) {
      return (
        <main className="page">
          <h1 className="page-title">Projects</h1>
          <p className="empty">Loading…</p>
        </main>
      );
    }
    return (
      <main className="page">
        <h1 className="page-title">Projects</h1>
        {state.loadError !== null ? (
          <>
            <p className="error-note">Could not reach the daemon: {state.loadError}</p>
            <button type="button" className="button" onClick={() => void boardStore.refresh().catch(() => {})}>
              Retry
            </button>
          </>
        ) : (
          <div className="empty-board-cta">
            <p className="empty">No projects connected yet.</p>
            <button type="button" className="button button-primary" onClick={openOnboarding}>
              Connect your first project
            </button>
            <p className="field-hint">
              Onboarding checks pi/gh auth, connects a repo, and registers the project.
            </p>
          </div>
        )}
      </main>
    );
  }

  const boards: KanbanBoard[] = state.projects.flatMap((p) => {
    const board = state.boards[p.id];
    return board === undefined ? [] : [board];
  });
  const workersByProject = state.projects.flatMap((p) => {
    const workers = state.workers[p.id];
    return workers === undefined || workers.length === 0 ? [] : [{ project: p, workers }];
  });

  return (
    <main className="page page-wide">
      <div className="board-header">
        <div>
          <h1 className="page-title">All projects</h1>
          <span className="project-repo">
            {state.projects.length} project{state.projects.length === 1 ? "" : "s"} · combined board
          </span>
        </div>
        <div className="board-actions">
          <ConnectionIndicator connection={state.connection} />
        </div>
      </div>

      {state.loadError !== null && <p className="error-note">Daemon unreachable: {state.loadError}</p>}
      {boards.length === 0 ? (
        <p className="empty">Loading boards…</p>
      ) : (
        <BoardColumns boards={boards} details={mergedCardDetails(boards, state.pullRequests)} />
      )}

      {workersByProject.map(({ project, workers }) => (
        <section key={project.id} className="combined-workers">
          <h2 className="combined-workers-title">{project.name}</h2>
          <WorkersPanel projectId={project.id} workers={workers} />
        </section>
      ))}
    </main>
  );
}
