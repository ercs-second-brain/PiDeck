/**
 * renderToString smoke test for the kanban board page (issue #244): the
 * store seam is stubbed (no network, no websocket — the same seam every
 * view test mocks), and the page renders through a MemoryRouter exactly
 * like the terminal view tests do. Assertions are on visible text, never
 * on class names.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { kanbanBoardSchema, projectSchema, workerSchema, type Project, type Worker } from "@pideck/shared";

const store = vi.hoisted(() => ({
  state: null as import("../store/store").AppState | null,
}));

vi.mock("../store/store", () => ({
  useAppState: () => store.state,
  boardStore: {
    getState: () => store.state,
    subscribe: () => () => {},
    loadProject: async () => {},
    refresh: async () => {},
    upsertProject: () => {},
  },
}));

import { BoardPage } from "./BoardPage";
import type { AppState } from "../store/store";

const PROJECT_ID = "demo";

const project: Project = projectSchema.parse({
  id: PROJECT_ID,
  name: "Demo",
  repoUrl: "https://github.com/o/r",
  defaultBranch: "main",
  settings: { autoAgentUsername: "octocat" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const worker: Worker = workerSchema.parse({
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

function board(): AppState["boards"][string] {
  return kanbanBoardSchema.parse({
    projectId: PROJECT_ID,
    updatedAt: "2026-01-02T00:00:00.000Z",
    columns: [
      { column: "backlog", cards: [] },
      { column: "in_progress", cards: [] },
      { column: "in_review", cards: [] },
      {
        column: "done",
        cards: [
          {
            id: "issue-9",
            projectId: PROJECT_ID,
            kind: "issue",
            number: 9,
            title: "card 9",
            column: "done",
            workerId: null,
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      },
    ],
  });
}

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    connection: "online",
    loaded: true,
    loadError: null,
    projects: [project],
    boards: { [PROJECT_ID]: board() },
    workers: { [PROJECT_ID]: [worker] },
    pullRequests: {},
    ...overrides,
  };
}

function renderBoard(path = `/projects/${PROJECT_ID}`): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:projectId" element={<BoardPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("BoardPage (issue #244 smoke)", () => {
  it("renders the project's identity, cards, workers and back link", () => {
    store.state = state();
    const html = renderBoard();
    expect(html).toContain("Demo");
    expect(html).toContain("https://github.com/o/r");
    expect(html).toContain("main");
    expect(html).toContain("auto-spawn @");
    expect(html).toContain("octocat");
    expect(html).toContain("card 9");
    expect(html).toContain("Workers");
    expect(html).toContain("w-1");
    expect(html).toContain("Working");
  });

  it("renders the not-found fallback for a project missing from the store", () => {
    store.state = state({ projects: [], boards: {}, workers: {} });
    const html = renderBoard();
    expect(html).toContain("not found");
  });

  it("renders the daemon-error note when the store failed to load", () => {
    store.state = state({ loadError: "connection refused" });
    expect(renderBoard()).toContain("Daemon unreachable:");
    expect(renderBoard()).toContain("connection refused");
  });
});
