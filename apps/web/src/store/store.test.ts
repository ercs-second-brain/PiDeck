/**
 * Unit tests for the live store's pure parts: the kanban event reducer and
 * the reconnect backoff schedule. (The store's REST/WS side effects are
 * inert in node — see the `window` guard in store.ts.)
 */

import { describe, expect, it } from "vitest";
import {
  kanbanBoardSchema,
  projectSchema,
  workerSchema,
  type KanbanCard,
  type KanbanColumn,
  type KanbanUpdateEvent,
} from "@agentskiss/shared";
import { applyKanbanEvent, type AppState } from "./store";
import { backoffDelayMs, nextBackoffMs } from "../lib/backoff";

const PROJECT_ID = "demo";

const project = projectSchema.parse({
  id: PROJECT_ID,
  name: "Demo",
  repoUrl: "https://github.com/o/r",
  defaultBranch: "main",
  settings: { autoAgentUsername: null },
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
