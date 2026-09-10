/**
 * Unit tests for the live store's pure parts: the kanban event reducer and
 * the reconnect backoff schedule. (The store's REST/WS side effects are
 * inert in node — see the `window` guard in store.ts.)
 */

import { describe, expect, it, vi } from "vitest";
import {
  kanbanBoardSchema,
  projectSchema,
  workerSchema,
  type KanbanCard,
  type KanbanColumn,
  type KanbanUpdateEvent,
  type Project,
  type PullRequest,
  type Worker,
} from "@pideck/shared";
import { applyKanbanEvent, boardStore, type AppState } from "./store";
import { backoffDelayMs, nextBackoffMs } from "../lib/backoff";

// The store's REST access is mocked: single-flight coalescing tests count
// calls instead of hitting the network (issue #88 regression tests).
vi.mock("../lib/api", () => ({
  apiListProjects: vi.fn(async () => [] as Project[]),
  apiGetKanban: vi.fn(async (_projectId: string) => {
    throw new Error("apiGetKanban not stubbed");
  }),
  apiListWorkers: vi.fn(async () => [] as Worker[]),
  apiListPullRequests: vi.fn(async () => [] as PullRequest[]),
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { apiGetKanban, apiListProjects } from "../lib/api";

const mockGetKanban = vi.mocked(apiGetKanban);
const mockListProjects = vi.mocked(apiListProjects);

const PROJECT_ID = "demo";

const project = projectSchema.parse({
  id: PROJECT_ID,
  name: "Demo",
  repoUrl: "https://github.com/o/r",
  defaultBranch: "main",
  settings: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

function card(id: string, column: KanbanColumn, number: number, kind: "issue" | "pull_request" = "issue"): KanbanCard {
  return {
    id,
    projectId: PROJECT_ID,
    kind,
    number,
    title: `card ${number}`,
    column,
    workerId: null,
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

function stateWithBoard(): AppState {
  const board = kanbanBoardSchema.parse({
    projectId: PROJECT_ID,
    updatedAt: "2026-01-02T00:00:00.000Z",
    columns: [
      { column: "backlog", cards: [card("issue-1", "backlog", 1)] },
      { column: "in_progress", cards: [] },
      { column: "in_review", cards: [card("pr-9", "in_review", 9, "pull_request")] },
      { column: "done", cards: [] },
    ],
  });
  return {
    connection: "online",
    loaded: true,
    loadError: null,
    projects: [project],
    boards: { [PROJECT_ID]: board },
    workers: {},
    pullRequests: {},
  };
}

describe("applyKanbanEvent: kanban.card.moved", () => {
  it("moves a card between columns (schema-valid event)", () => {
    const state = stateWithBoard();
    const movedCard = card("issue-1", "in_progress", 1);
    movedCard.workerId = "w-1";
    const event: KanbanUpdateEvent = {
      type: "kanban.card.moved",
      at: "2026-01-03T00:00:00.000Z",
      projectId: PROJECT_ID,
      cardId: "issue-1",
      from: "backlog",
      to: "in_progress",
      card: movedCard,
    };

    const next = applyKanbanEvent(state, event);
    expect(next).not.toBe(state); // immutable
    const columns = next.boards[PROJECT_ID]!.columns;
    expect(columns.find((c) => c.column === "backlog")!.cards).toHaveLength(0);
    const target = columns.find((c) => c.column === "in_progress")!.cards;
    expect(target).toHaveLength(1);
    expect(target[0]).toEqual(movedCard);
  });

  it("ignores events for boards that are not loaded yet", () => {
    const state: AppState = { ...stateWithBoard(), boards: {} };
    const event: KanbanUpdateEvent = {
      type: "kanban.card.moved",
      at: "2026-01-03T00:00:00.000Z",
      projectId: PROJECT_ID,
      cardId: "issue-1",
      from: "backlog",
      to: "done",
      card: card("issue-1", "done", 1),
    };
    expect(applyKanbanEvent(state, event)).toBe(state);
  });

  it("updates the board timestamp", () => {
    const state = stateWithBoard();
    const event: KanbanUpdateEvent = {
      type: "kanban.card.moved",
      at: "2026-02-03T00:00:00.000Z",
      projectId: PROJECT_ID,
      cardId: "pr-9",
      from: "in_review",
      to: "done",
      card: card("pr-9", "done", 9, "pull_request"),
    };
    expect(applyKanbanEvent(state, event).boards[PROJECT_ID]!.updatedAt).toBe("2026-02-03T00:00:00.000Z");
  });
});

describe("applyKanbanEvent: project.updated", () => {
  it("replaces an existing project", () => {
    const state = stateWithBoard();
    const renamed = { ...project, name: "Renamed" };
    const next = applyKanbanEvent(state, { type: "project.updated", at: "2026-01-03T00:00:00.000Z", project: renamed });
    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]!.name).toBe("Renamed");
  });

  it("appends a previously unknown project", () => {
    const state: AppState = { ...stateWithBoard(), projects: [] };
    const next = applyKanbanEvent(state, { type: "project.updated", at: "2026-01-03T00:00:00.000Z", project });
    expect(next.projects).toEqual([project]);
  });
});

describe("applyKanbanEvent: workers", () => {
  const worker = workerSchema.parse({
    id: "w-1",
    projectId: PROJECT_ID,
    sessionId: "s-1",
    issueNumber: 0, // freeform worker
    prNumber: null,
    status: "running",
    statusMessage: "Working",
    startedAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });

  it("worker.spawned appends to the project's worker list", () => {
    const state = stateWithBoard();
    const next = applyKanbanEvent(state, { type: "worker.spawned", at: "2026-01-03T00:00:00.000Z", worker });
    expect(next.workers[PROJECT_ID]).toEqual([worker]);
    // Idempotent on re-spawn of the same worker id.
    const twice = applyKanbanEvent(next, { type: "worker.spawned", at: "2026-01-03T00:00:00.000Z", worker });
    expect(twice.workers[PROJECT_ID]).toHaveLength(1);
  });

  it("worker.status.changed patches status and timestamp", () => {
    const state: AppState = { ...stateWithBoard(), workers: { [PROJECT_ID]: [worker] } };
    const next = applyKanbanEvent(state, {
      type: "worker.status.changed",
      at: "2026-01-04T00:00:00.000Z",
      projectId: PROJECT_ID,
      workerId: "w-1",
      status: "awaiting_ci",
    });
    expect(next.workers[PROJECT_ID]![0]!.status).toBe("awaiting_ci");
    expect(next.workers[PROJECT_ID]![0]!.updatedAt).toBe("2026-01-04T00:00:00.000Z");
    expect(next.workers[PROJECT_ID]![0]!.statusMessage).toBe("Working");
  });

  it("worker.status.changed is a no-op for unknown workers", () => {
    const state: AppState = { ...stateWithBoard(), workers: { [PROJECT_ID]: [] } };
    const next = applyKanbanEvent(state, {
      type: "worker.status.changed",
      at: "2026-01-04T00:00:00.000Z",
      projectId: PROJECT_ID,
      workerId: "w-unknown",
      status: "done",
    });
    expect(next).toBe(state);
  });
});

describe("boardStore.onWorkerEvent (issue #269)", () => {
  const worker = workerSchema.parse({
    id: "w-evt", projectId: PROJECT_ID, sessionId: "s-evt", issueNumber: 0, prNumber: null,
    status: "running", statusMessage: null,
    startedAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
  });

  it("notifies subscribers for worker lifecycle events, even reducer no-ops", () => {
    const seen: KanbanUpdateEvent[] = [];
    const unsubscribe = boardStore.onWorkerEvent((event) => seen.push(event));
    boardStore.apply({ type: "worker.spawned", at: "2026-01-03T00:00:00.000Z", worker });
    // A reducer no-op (unknown worker) still notifies — the sidebar decides.
    boardStore.apply({ type: "worker.status.changed", at: "2026-01-04T00:00:00.000Z", projectId: PROJECT_ID, workerId: "w-unknown", status: "done" });
    expect(seen.map((event) => event.type)).toEqual(["worker.spawned", "worker.status.changed"]);
    // Unsubscribed listeners go quiet; non-worker events never notify.
    unsubscribe();
    boardStore.apply({ type: "worker.spawned", at: "2026-01-03T00:00:00.000Z", worker });
    boardStore.apply({ type: "kanban.card.moved", at: "2026-01-03T00:00:00.000Z", projectId: PROJECT_ID, cardId: "issue-1", from: "backlog", to: "in_progress", card: card("issue-1", "in_progress", 1) });
    expect(seen.map((event) => event.type)).toEqual(["worker.spawned", "worker.status.changed"]);
  });

  it("notifies subscribers for session.archived (issue #358 — the poll-gap finding)", () => {
    const seen: KanbanUpdateEvent[] = [];
    const unsubscribe = boardStore.onWorkerEvent((event) => seen.push(event));
    const archiveEvent = {
      type: "session.archived" as const,
      at: "2026-01-05T00:00:00.000Z",
      projectId: PROJECT_ID,
      sessionId: "sess-agent-1",
      agentKind: "devex-audit",
      rootSessionId: "sess-agent-1",
    };
    // The reduction is a no-op (no persona-agent records in state), but the
    // sidebar still learns instantly via the listener (the reload is the update).
    boardStore.apply(archiveEvent);
    expect(seen.map((event) => event.type)).toEqual(["session.archived"]);
    unsubscribe();
  });
});

describe("reconnect backoff", () => {
  it("doubles from 500ms and caps at 8s", () => {
    expect(backoffDelayMs(1)).toBe(500);
    expect(backoffDelayMs(2)).toBe(1000);
    expect(backoffDelayMs(4)).toBe(4000);
    expect(backoffDelayMs(5)).toBe(8000);
    expect(backoffDelayMs(50)).toBe(8000);
  });

  it("applies ±25% jitter", () => {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const base = backoffDelayMs(attempt);
      const delay = nextBackoffMs(attempt);
      expect(delay).toBeGreaterThanOrEqual(base * 0.75);
      expect(delay).toBeLessThanOrEqual(base * 1.25);
    }
  });
});

// ---------------------------------------------------------------------------
// Registration seeding (issue #203)
// ---------------------------------------------------------------------------

describe("boardStore.upsertProject (issue #203)", () => {
  it("seeds a just-registered project and loads its board without a refresh", async () => {
    const id = "fresh-203";
    const fresh = { ...project, id, name: "Fresh" };
    const board = stateWithBoard().boards[PROJECT_ID]!;
    mockGetKanban.mockResolvedValue(board);

    boardStore.upsertProject(fresh);

    // The sidebar/board's project lookup finds it immediately…
    expect(boardStore.getState().projects.find((p) => p.id === id)).toEqual(fresh);
    // …and the board data loads via the normal single-flight path.
    await vi.waitFor(() => {
      expect(boardStore.getState().boards[id]).toEqual(board);
    });
  });

  it("replaces an existing project without duplicating it", () => {
    const renamed = { ...project, name: "Renamed via register" };
    mockGetKanban.mockResolvedValue(stateWithBoard().boards[PROJECT_ID]!);
    boardStore.upsertProject(renamed);
    const matches = boardStore.getState().projects.filter((p) => p.id === PROJECT_ID);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.name).toBe("Renamed via register");
  });

  it("shares the board load with a concurrent loadProject (single-flight, #97 intact)", async () => {
    const id = "race-203";
    const board = stateWithBoard().boards[PROJECT_ID]!;
    mockGetKanban.mockResolvedValue(board);
    await Promise.all([
      boardStore.loadProject(id),
      new Promise<void>((resolve) => {
        boardStore.upsertProject({ ...project, id });
        resolve();
      }),
    ]);
    expect(mockGetKanban.mock.calls.filter(([projectId]) => projectId === id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Single-flight coalescing (issue #88 regression tests)
//
// The store's REST side effects are inert in node (`window` guard), so these
// drive the app-wide singleton directly with a mocked api lib. Each test
// uses its own project id: state accumulates on the singleton across tests.
// ---------------------------------------------------------------------------

describe("boardStore single-flight coalescing (issue #88)", () => {
  it("coalesces concurrent loadProject calls into one fetch round per project", async () => {
    const id = "coalesce";
    const board = stateWithBoard().boards[PROJECT_ID]!;
    mockGetKanban.mockImplementation(async () => board);
    await Promise.all([
      boardStore.loadProject(id),
      boardStore.loadProject(id),
      boardStore.loadProject(id),
      boardStore.loadProject(id),
    ]);
    expect(mockGetKanban.mock.calls.filter(([projectId]) => projectId === id)).toHaveLength(1);
    expect(boardStore.getState().boards[id]).toEqual(board);
  });

  it("does not share loads across different projects", async () => {
    const board = stateWithBoard().boards[PROJECT_ID]!;
    mockGetKanban.mockImplementation(async () => board);
    await Promise.all([boardStore.loadProject("solo-a"), boardStore.loadProject("solo-b")]);
    expect(mockGetKanban.mock.calls.filter(([projectId]) => projectId.startsWith("solo-"))).toHaveLength(2);
  });

  it("retries a failed project load on the next call (failures are not cached)", async () => {
    const id = "retry";
    const board = stateWithBoard().boards[PROJECT_ID]!;
    mockGetKanban.mockImplementationOnce(async () => {
      throw new Error("kanban down");
    });
    mockGetKanban.mockImplementationOnce(async () => board);
    await expect(boardStore.loadProject(id)).rejects.toThrow("kanban down");
    await expect(boardStore.loadProject(id)).resolves.toBeUndefined();
    expect(mockGetKanban.mock.calls.filter(([projectId]) => projectId === id)).toHaveLength(2);
  });

  it("coalesces concurrent refresh calls into one project-list fetch", async () => {
    mockListProjects.mockResolvedValueOnce([project]);
    await Promise.all([boardStore.refresh(), boardStore.refresh(), boardStore.refresh()]);
    expect(mockListProjects).toHaveBeenCalledTimes(1);
    expect(boardStore.getState().projects).toEqual([project]);
    expect(boardStore.getState().loaded).toBe(true);
  });
});
