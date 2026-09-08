/**
 * Tests for the sidebar's workspace-level global agent row (the hierarchy's
 * top layer: global agent → project orchestrators → workers → review
 * agents): rendered above every project row, the whole row is the
 * chat/attach affordance, and it renders regardless of project-list state.
 * The picker is pure, so it is exercised directly without xterm or effects.
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

describe("global agent row (workspace hierarchy)", () => {
  it("renders above the project rows, before the header's project list", () => {
    const html = renderPicker({ entries: [entry] });
    expect(html).toContain("picker-global-row");
    expect(html).toContain("Global agent");
    // Hierarchy top: the global row comes first, then the project rows
    // (the collapse chevron is emitted only by real project rows).
    expect(html.indexOf("picker-global-row")).toBeLessThan(html.indexOf("picker-project-chevron"));
  });

  it("renders before the global agent exists (first click starts it) and while starting", () => {
    expect(renderPicker()).toContain("picker-global-row");
    expect(renderPicker({ startingGlobalAgent: true })).toContain("disabled");
  });

  it("marks the row selected when the global agent's terminal is attached", () => {
    const html = renderPicker({ globalAgent, selectedSessionId: globalAgent.id });
    expect(html).toContain("picker-project-chat selected");
    expect(html).toContain("picker-global-name selected");
  });
});
