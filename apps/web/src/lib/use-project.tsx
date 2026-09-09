/**
 * Resolves the project for a project id (BoardPage, the project settings
 * modal): triggers the store's project load when the id first appears, and
 * returns the project, the store's loaded flag, and a fallback to render
 * while it is missing — the loading notice, or the not-found page once the
 * store has loaded.
 *
 * A 404 here usually means the project was just registered and the local
 * project list is stale — the load's failure path refreshes the whole list
 * so the board appears without waiting for the next poll.
 */
import { useEffect } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { Project } from "@pideck/shared";
import { boardStore, useAppState } from "../store/store";

export function useProject(projectId: string | undefined): { project: Project | undefined; loaded: boolean; fallback: ReactNode } {
  const state = useAppState();

  useEffect(() => {
    if (projectId === undefined) return;
    void boardStore.loadProject(projectId).catch(() => boardStore.refresh());
  }, [projectId]);

  const project = state.projects.find((p) => p.id === projectId);
  return {
    project,
    loaded: state.loaded,
    fallback:
      project === undefined ? (
        <main className="page">
          <p className="empty">{state.loaded ? `Project “${projectId ?? "?"}” not found.` : "Loading…"}</p>
          <Link to="/" className="back-link">
            ← All projects
          </Link>
        </main>
      ) : null,
  };
}
