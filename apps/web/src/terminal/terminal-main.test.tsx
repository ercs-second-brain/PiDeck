/**
 * Tests for the terminal main pane (issue #62): attaches the selected
 * session from the sidebar context, falls back to the attach hint, and
 * shows the first-run onboarding CTA when no projects are connected.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";

// TerminalPage renders TerminalPane; stub the xterm browser modules so the
// pane component can be imported in a node test environment.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
import type { Session, Worker } from "@pideck/shared";
import { makeProject } from "./test-fixtures";
import { TerminalPage } from "./TerminalPage";
import { SidebarContext, type SidebarContextValue } from "./sidebar";
import type { ProjectEntry } from "./SessionPicker";

const project = makeProject();

const sessions: Session[] = [
  {
    id: "sess-orch-1",
    projectId: "agentskiss",
    role: "orchestrator",
    tmuxSession: "pideck-agentskiss-orchestrator-1",
    workerId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
  },
];

const entry: ProjectEntry = { project, sessions, workers: [] as Worker[] };

const globalAgentSession: Session = {
  id: "sess-global-1",
  projectId: "global",
  role: "orchestrator",
  tmuxSession: "pideck-global-orchestrator-1",
  workerId: null,
  createdAt: "2025-01-01T00:00:00.000Z",
};

function renderMain(path: string, context: Partial<SidebarContextValue>) {
  const value: SidebarContextValue = {
    entries: context.entries ?? [entry],
    error: context.error ?? null,
    loaded: context.loaded ?? true,
    startingProjectId: null,
    globalAgent: context.globalAgent ?? null,
    startingGlobalAgent: false,
    reload: () => {},
    startOrchestrator: () => {},
    startGlobalAgent: () => {},
    terminateWorker: async () => {},
    deleteProject: async () => {},
    spawnAgentSession: async () => {},
    terminateAgentSession: async () => {},
    openOnboarding: () => {},
    ...context,
  };
  return renderToString(
    <SidebarContext.Provider value={value}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/terminal" element={<TerminalPage />} />
          <Route path="/terminal/:sessionId" element={<TerminalPage />} />
        </Routes>
      </MemoryRouter>
    </SidebarContext.Provider>,
  );
}

describe("TerminalPage (main pane)", () => {
  it("attaches the selected session's terminal", () => {
    const html = renderMain("/terminal/sess-orch-1", {});
    expect(html).toContain("terminal-pane");
    expect(html).toContain("terminal-statusbar");
  });

  it("shows the attach hint when no session is selected", () => {
    const html = renderMain("/terminal", {});
    expect(html).toContain("Select a session to attach.");
  });

  it("attaches the global agent's terminal from the sidebar context (workspace hierarchy)", () => {
    // The global agent belongs to no project entry — it arrives separately.
    const html = renderMain("/terminal/sess-global-1", { entries: [], globalAgent: globalAgentSession });
    expect(html).toContain("terminal-pane");
    expect(html).toContain("terminal-statusbar");
  });

  it("keeps the attach hint when only an unknown session id is selected", () => {
    const html = renderMain("/terminal/sess-unknown", { globalAgent: globalAgentSession });
    expect(html).toContain("Select a session to attach.");
  });

  it("shows the onboarding CTA on the first run with zero projects", () => {
    const html = renderMain("/terminal", { entries: [] });
    expect(html).toContain("Connect your first project");
  });

  it("shows a loading placeholder (not the CTA) while the project list loads (issue #90)", () => {
    const html = renderMain("/terminal", { entries: [], loaded: false });
    expect(html).toContain("Loading projects…");
    expect(html).not.toContain("Connect your first project");
  });

  it("keeps the loading placeholder while loading even on a deep link (issue #90)", () => {
    const html = renderMain("/terminal/sess-orch-1", { entries: [], loaded: false });
    expect(html).toContain("Loading projects…");
    expect(html).not.toContain("terminal-pane");
  });

  it("keeps the attach hint when the daemon is unreachable (no CTA)", () => {
    const html = renderMain("/terminal", { entries: [], error: "connection refused" });
    expect(html).toContain("Select a session to attach.");
    expect(html).not.toContain("Connect your first project");
  });
});
