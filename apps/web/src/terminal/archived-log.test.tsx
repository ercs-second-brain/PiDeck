/**
 * Tests for the archived worker log view (issue #104): the sidebar's archived
 * rows open a read-only log (captured scrollback + final metadata) in the
 * main pane instead of a dead terminal.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";

// TerminalPage renders TerminalPane; stub the xterm browser modules so the
// pane component can be imported in a node test environment.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
import type { Session, Worker } from "@pideck/shared";
import { makeProject } from "./test-fixtures";
import { ArchivedLogPanel, ArchivedLogView } from "./ArchivedLogView";
import { TerminalPage } from "./TerminalPage";
import { SidebarContext, type SidebarContextValue } from "./sidebar";
import type { ProjectEntry } from "./SessionPicker";

const project = makeProject();

const workerSession: Session = {
  id: "sess-worker-1",
  projectId: "agentskiss",
  role: "worker",
  tmuxSession: "pideck-agentskiss-worker-1",
  workerId: "worker-1",
  createdAt: "2025-01-01T00:00:00.000Z",
};

const archivedWorker: Worker = {
  id: "worker-1",
  projectId: "agentskiss",
  sessionId: "sess-worker-1",
  issueNumber: 104,
  prNumber: 110,
  status: "archived",
  statusMessage: "archived: terminated from the webapp",
  startedAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-02T00:00:00.000Z",
};

const entry: ProjectEntry = { project, sessions: [workerSession], workers: [archivedWorker] };

function renderMain(sessionId: string, contextEntries: ProjectEntry[] = [entry]) {
  const value: SidebarContextValue = {
    entries: contextEntries,
    error: null,
    loaded: true,
    startingProjectId: null,
    globalAgent: null,
    startingGlobalAgent: false,
    reload: () => {},
    startOrchestrator: () => {},
    startGlobalAgent: () => {},
    terminateWorker: async () => {},
    deleteProject: async () => {},
    spawnAgentSession: async () => {},
    openOnboarding: () => {},
  };
  return renderToString(
    <SidebarContext.Provider value={value}>
      <MemoryRouter initialEntries={[`/terminal/${sessionId}`]}>
        <Routes>
          <Route path="/terminal/:sessionId" element={<TerminalPage />} />
        </Routes>
      </MemoryRouter>
    </SidebarContext.Provider>,
  );
}

describe("ArchivedLogPanel (issue #104)", () => {
  it("renders the captured scrollback and the worker's final metadata", () => {
    const html = renderToString(
      <ArchivedLogPanel
        log={{
          workerId: "worker-1",
          projectId: "agentskiss",
          issueNumber: 104,
          prNumber: 110,
          prompt: "Implement #104: archived log viewer",
          finalStatus: "archived",
          finalStatusMessage: "archived: terminated from the webapp",
          startedAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-02T00:00:00.000Z",
          capturedAt: "2025-01-02T00:00:00.000Z",
          scrollback: "line one\nline two",
        }}
        prUrl="https://github.com/ercs-second-brain/agentsKISS/pull/110"
      />,
    );
    expect(html).toContain("archived-log-scrollback");
    expect(html).toContain("line one");
    expect(html).toContain("line two");
    expect(html).toContain("issue #104");
    expect(html).toContain("Implement #104: archived log viewer");
    expect(html).toContain("pull/110");
    expect(html).toContain("archived: terminated from the webapp");
    expect(html).toContain("Read-only");
  });

  it("explains a missing capture and omits the PR row when there is none", () => {
    const html = renderToString(
      <ArchivedLogPanel
        log={{
          workerId: "worker-1",
          projectId: "agentskiss",
          issueNumber: 0,
          prNumber: null,
          prompt: null,
          finalStatus: "archived",
          finalStatusMessage: null,
          startedAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-02T00:00:00.000Z",
          capturedAt: null,
          scrollback: "",
        }}
      />,
    );
    expect(html).toContain("no scrollback captured");
    expect(html).toContain("freeform task");
    expect(html).not.toContain("archived-log-prompt");
    expect(html).not.toContain("PR");
  });
});

describe("TerminalPage archived worker (issue #104)", () => {
  it("opens the read-only archived log instead of a terminal for an archived worker", () => {
    const html = renderMain("sess-worker-1");
    expect(html).toContain("archived-log");
    expect(html).not.toContain("terminal-pane");
  });

  it("still attaches the live terminal for a non-archived session", () => {
    const liveWorker: Worker = { ...archivedWorker, status: "running" };
    const html = renderMain("sess-worker-1", [{ project, sessions: [workerSession], workers: [liveWorker] }]);
    expect(html).toContain("terminal-pane");
    expect(html).not.toContain("archived-log");
  });

  it("ArchivedLogView starts in the loading state before the fetch resolves", () => {
    const html = renderToString(<ArchivedLogView workerId="worker-1" />);
    expect(html).toContain("Loading archived log");
  });
});
