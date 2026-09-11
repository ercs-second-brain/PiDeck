/**
 * Issue #451 web-store tests, split from store.test.ts (line budget):
 * the `kanban.board.updated` reducer (a background SWR refresh re-derived a
 * different board — open views replace their cached copy wholesale) and the
 * worker-event board reload.
 */

import { describe, expect, it, vi } from "vitest";
import { kanbanBoardSchema, workerSchema } from "@pideck/shared";

import { applyKanbanEvent, boardStore, type AppState } from "./store";

// The store's REST access is mocked: the worker-event reload drives the
// singleton's loadProject directly (REST side effects are inert in node).
vi.mock("../lib/api", () => ({
  apiListProjects: vi.fn(async () => []),
  apiGetKanban: vi.fn(async () => {
    throw new Error("apiGetKanban not stubbed");
  }),
  apiListWorkers: vi.fn(async () => []),
  apiListPullRequests: vi.fn(async () => []),
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { apiGetKanban } from "../lib/api";

const mockGetKanban = vi.mocked(apiGetKanban);
const PROJECT_ID = "demo";

function board(projectId: string, columns: Array<{ column: "backlog" | "in_progress" | "in_review" | "done"; cards: never[] }>) {
  return kanbanBoardSchema.parse({ projectId, updatedAt: "2026-01-06T00:00:00.000Z", columns });
}

describe("applyKanbanEvent: kanban.board.updated (issue #451)", () => {
  const state: AppState = {
    connection: "online",
    loaded: true,
    loadError: null,
    projects: [],
    boards: {},
    workers: {},
    pullRequests: {},
  };

  it("replaces the cached board wholesale", () => {
    const fresh = board(PROJECT_ID, [{ column: "in_progress", cards: [] }]);
    const withBoard = { ...state, boards: { [PROJECT_ID]: board(PROJECT_ID, [{ column: "backlog", cards: [] }]) } };
    const next = applyKanbanEvent(withBoard, { type: "kanban.board.updated", at: "2026-01-06T00:00:00.000Z", board: fresh });
    expect(next.boards[PROJECT_ID]).toEqual(fresh);
  });

  it("lands a board for a project with no prior copy (never navigated)", () => {
    const fresh = board("other", [{ column: "backlog", cards: [] }]);
    const next = applyKanbanEvent(state, { type: "kanban.board.updated", at: "2026-01-06T00:00:00.000Z", board: fresh });
    expect(next.boards["other"]).toEqual(fresh);
  });

  it("reloads the project's board when a worker lifecycle event lands (issue #451)", async () => {
    // The daemon keys its board cache on the worker-state generation, so the
    // reload re-derives fresh card placement instead of the pre-event board.
    mockGetKanban.mockImplementation(async () => board(PROJECT_ID, [{ column: "backlog", cards: [] }]));
    const worker = workerSchema.parse({
      id: "w-1",
      projectId: PROJECT_ID,
      sessionId: "s-1",
      issueNumber: 0,
      prNumber: null,
      status: "running",
      statusMessage: null,
      startedAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    boardStore.apply({ type: "worker.spawned", at: "2026-01-03T00:00:00.000Z", worker });
    await vi.waitFor(() => expect(mockGetKanban).toHaveBeenCalledWith(PROJECT_ID, false));
  });
});