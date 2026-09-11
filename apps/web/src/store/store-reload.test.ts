/**
 * Store reload triggers (issue #451): events that signal server-derived
 * state changed without carrying it trigger a project reload — the board
 * push on daemon-side revalidation (`kanban.board.updated`) and the worker
 * lifecycle events (issue columns derive from live worker status). Split
 * from `store.test.ts` (theme tests + the file's line budget).
 */

import { describe, expect, it, vi } from "vitest";
import { kanbanBoardSchema, type Project, type PullRequest, type Worker } from "@pideck/shared";

import { boardStore } from "./store";
vi.mock("../lib/api", () => ({
  apiListProjects: vi.fn(async () => [] as Project[]),
  apiGetKanban: vi.fn(async (_projectId: string) => {
    throw new Error("apiGetKanban not stubbed");
  }),
  apiListWorkers: vi.fn(async () => [] as Worker[]),
  apiListPullRequests: vi.fn(async () => [] as PullRequest[]),
}));

import { apiGetKanban } from "../lib/api";

const mockGetKanban = vi.mocked(apiGetKanban);

const PROJECT_ID = "demo";

/** Minimal schema-valid board — the reload fires regardless of board content. */
function board(): ReturnType<typeof kanbanBoardSchema.parse> {
  return kanbanBoardSchema.parse({
    projectId: PROJECT_ID,
    updatedAt: "2026-01-02T00:00:00.000Z",
    columns: [
      { column: "backlog", cards: [] },
      { column: "in_progress", cards: [] },
      { column: "in_review", cards: [] },
      { column: "done", cards: [] },
    ],
  });
}

describe("boardStore reload triggers (issue #451)", () => {
  it("reloads a loaded project on kanban.board.updated (push-on-revalidate)", async () => {
    const id = "push-451";
    mockGetKanban.mockResolvedValue(board());
    await boardStore.loadProject(id);
    const callsBefore = mockGetKanban.mock.calls.filter(([projectId]) => projectId === id).length;

    boardStore.apply({ type: "kanban.board.updated", at: "2026-01-03T00:00:00.000Z", projectId: id });
    await vi.waitFor(() => {
      expect(mockGetKanban.mock.calls.filter(([projectId]) => projectId === id).length).toBeGreaterThan(callsBefore);
    });
  });

  it("reloads the project on worker lifecycle events (worker-derived issue columns)", async () => {
    mockGetKanban.mockResolvedValue(board());
    await boardStore.loadProject(PROJECT_ID);
    const callsBefore = mockGetKanban.mock.calls.filter(([projectId]) => projectId === PROJECT_ID).length;

    boardStore.apply({ type: "worker.status.changed", at: "2026-01-03T00:00:00.000Z", projectId: PROJECT_ID, workerId: "w-unknown-451", status: "awaiting_ci" });
    await vi.waitFor(() => {
      expect(mockGetKanban.mock.calls.filter(([projectId]) => projectId === PROJECT_ID).length).toBeGreaterThan(callsBefore);
    });
  });

  it("ignores pushes for projects the client has not loaded", async () => {
    boardStore.apply({ type: "kanban.board.updated", at: "2026-01-03T00:00:00.000Z", projectId: "never-loaded-451" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockGetKanban.mock.calls.filter(([projectId]) => projectId === "never-loaded-451")).toHaveLength(0);
  });
});
