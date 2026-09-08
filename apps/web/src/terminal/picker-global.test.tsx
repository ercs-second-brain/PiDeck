/**
 * Tests for the sidebar's workspace-level agent row (the hierarchy's top
 * layer: workspace agent → project orchestrators → workers → review
 * agents, issue #259): rendered above every project row, labeled
 * "Workspace" (display only — the daemon's reserved `global` id and API
 * are unchanged), the NAME opens the all-projects (workspace) board, the
 * chat icon starts/attaches the workspace agent, and the whole row is
 * DISABLED until at least one project exists (issue #259, B3). The picker
 * is pure, so it is exercised directly without xterm or effects.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { Session } from "@pideck/shared";
import { SessionPicker, type ProjectEntry } from "./SessionPicker";

const globalAgent: Session = {
  id: "sess-global-1",
  projectId: "global",
  role: "orchestrator",
  tmuxSession: "pideck-global-orchestrator-1",
  workerId: null,
  createdAt: "2025-01-01T00:00:00.000Z",
};

const entry: ProjectEntry = {
  project: {
    id: "agentskiss",
    name: "agentsKISS",
    repoUrl: "https://github.com/o/r",
    defaultBranch: "main",
    settings: { autoAgentUsername: null, workerConcurrency: 2 },
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
  sessions: [],
  workers: [],
};

function renderPicker(overrides: Partial<Parameters<typeof SessionPicker>[0]> = {}): string {
  return renderToString(
    <SessionPicker
      entries={overrides.entries ?? []}
      error={overrides.error ?? null}
      loading={overrides.loading}
      selectedSessionId={overrides.selectedSessionId ?? null}
      allProjectsSelected={overrides.allProjectsSelected}
      globalAgent={overrides.globalAgent}
      startingGlobalAgent={overrides.startingGlobalAgent}
      onSelectSession={() => {}}
      onSelectProject={() => {}}
      onOpenSettings={() => {}}
      onSelectAllProjects={() => {}}
      onStartOnboarding={() => {}}
      onOpenGlobalSettings={() => {}}
      onStartOrchestrator={() => {}}
      onStartGlobalAgent={() => {}}
    />,
  );
}

describe("workspace row (issue #259)", () => {
  it("renders above the project rows as the sidebar's first entry", () => {
    const html = renderPicker({ entries: [entry] });
    expect(html).toContain("picker-global-row");
    // Display rename (#259, B5): "Workspace", not "Global agent".
    expect(html).toContain("Workspace");
    expect(html).not.toContain("Global agent");
    // Hierarchy top: the workspace row comes first, then the project rows
    // (the collapse chevron is emitted only by real project rows).
    expect(html.indexOf("picker-global-row")).toBeLessThan(html.indexOf("picker-project-chevron"));
  });

  it("opens the workspace (all-projects) board from the name click (B6)", () => {
    const html = renderPicker({ entries: [entry] });
    expect(html).toContain("title=\"Open the workspace board\"");
    // Selected while the all-projects board is open in the main pane.
    const boardOpen = renderPicker({ entries: [entry], allProjectsSelected: true });
    expect(boardOpen).toContain("picker-global-name selected");
  });

  it("starts the workspace agent from the chat icon (B6)", () => {
    const html = renderPicker({ entries: [entry] });
    expect(html).toContain("Start the workspace agent");
    expect(renderPicker({ entries: [entry], startingGlobalAgent: true })).toContain("pending");
  });

  it("is disabled until at least one project exists (B3)", () => {
    const empty = renderPicker();
    expect(empty).toContain("disabled");
    // Enabled once a project exists.
    const withProject = renderPicker({ entries: [entry] });
    expect(withProject).not.toContain("disabled");
  });

  it("marks the chat icon selected when the workspace agent's terminal is attached", () => {
    const html = renderPicker({ entries: [entry], globalAgent, selectedSessionId: globalAgent.id });
    expect(html).toContain("picker-project-chat selected");
    expect(html).toContain("picker-global-name");
  });
});
