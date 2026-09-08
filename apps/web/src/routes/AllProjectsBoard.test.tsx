/**
 * renderToString smoke test for the all-projects combined board (issue
 * #244): the store seam is stubbed (the same seam every view test mocks —
 * no network, no websocket) and the sidebar context seam is stubbed so the
 * onboarding CTA can render outside the app shell. Assertions are on
 * visible text, never on class names.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
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

vi.mock("../terminal/sidebar", () => ({
  useSidebar: () => ({ openOnboarding: () => {} }),
}));

import { AllProjectsBoard } from "./AllProjectsBoard";
import type { AppState } from "../store/store";

function project(id: string, name: string): Project {
  return projectSchema.parse({
    id,
    name,
    repoUrl: `https://github.com/o/${id}`,
    defaultBranch: "main",
    settings: { autoAgentUsername: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function worker(id: string, projectId: string): Worker {
  return workerSchema.parse({
    id,
    projectId,
    sessionId: `session-${id}`,
    issueNumber: 0, // freeform worker
    prNumber: null,
    status: "running",
    statusMessage: "Working",
    startedAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });
}

function board(projectId: string, cardTitle: string): AppState["boards"][string] {
  return kanbanBoardSchema.parse({
    projectId,
    updatedAt: "2026-01-02T00:00:00.000Z",
    columns: [
      { column: "backlog", cards: [] },
      {
        column: "in_progress",
        cards: [
          {
            id: `issue-${projectId}`,
            projectId,
            kind: "issue",
            number: 9,
            title: cardTitle,
            column: "in_progress",
            workerId: null,
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      },
      { column: "in_review", cards: [] },
      { column: "done", cards: [] },
    ],
  });
}

function render(): string {
  // WorkersPanel renders react-router Links, so the board needs a router
  // context even though this smoke test never navigates.
  return renderToString(
    <MemoryRouter initialEntries={["/"]}>
      <AllProjectsBoard />
    </MemoryRouter>,
  );
}

describe("AllProjectsBoard (issue #244 smoke)", () => {
  it("renders the first-run onboarding entry point when no projects exist yet", () => {
    store.state = { connection: "online", loaded: true, loadError: null, projects: [], boards: {}, workers: {}, pullRequests: {} };
    const html = render();
    expect(html).toContain("Projects");
    expect(html).toContain("No projects connected yet.");
    expect(html).toContain("Connect your first project");
    expect(html).toContain("Onboarding checks pi/gh auth");
  });

  it("renders the loading notice before the first project-list fetch completes", () => {
    store.state = { connection: "connecting", loaded: false, loadError: null, projects: [], boards: {}, workers: {}, pullRequests: {} };
    const html = render();
    expect(html).toContain("Projects");
    expect(html).toContain("Loading…");
  });

  it("renders the honest daemon error with a retry when the project list failed", () => {
    store.state = { connection: "offline", loaded: true, loadError: "connection refused", projects: [], boards: {}, workers: {}, pullRequests: {} };
    const html = render();
    expect(html).toContain("Could not reach the daemon:");
    expect(html).toContain("connection refused");
    expect(html).toContain("Retry");
  });

  it("renders the combined board with per-project counts, cards and workers", () => {
    store.state = {
      connection: "online",
      loaded: true,
      loadError: null,
      projects: [project("demo", "Demo"), project("beta", "Beta")],
      boards: { demo: board("demo", "card 9"), beta: board("beta", "card 7") },
      workers: { demo: [worker("w-1", "demo")], beta: [worker("w-2", "beta")] },
      pullRequests: {},
    };
    const html = render().replace(/<!-- -->/g, ""); // rejoin React's text-node separators
    expect(html).toContain("All projects");
    expect(html).toContain("2 projects · combined board");
    expect(html).toContain("live"); // ConnectionIndicator's online label
    expect(html).toContain("card 9");
    expect(html).toContain("card 7");
    expect(html).toContain("w-1");
    expect(html).toContain("w-2");
    expect(html).toContain("Demo");
    expect(html).toContain("Beta");
  });
});
