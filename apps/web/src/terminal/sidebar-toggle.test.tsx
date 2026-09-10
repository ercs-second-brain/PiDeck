/**
 * Issues #354/#373: the sidebar's inline collapse toggle (desktop). When the
 * shell wires `onToggleSidebar`, the WORKSPACE ROW hosts a small toggle icon
 * at its right edge (issue #373 B21a — the former top bar is gone) —
 * pointing left while open, right while collapsed — replacing the header
 * hamburger on desktop (which stays mobile-only, CSS-side). Pure render
 * tests: presence, placement, direction, and aria state. The collapsed-rail
 * visibility contract (B21b: the toggle outlives the rest of the panel) is
 * pinned in picker-row-layout.test.tsx.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { Session, Worker } from "@pideck/shared";
import { makeProject } from "./test-fixtures";
import { SessionPicker } from "./SessionPicker";

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

const workers: Worker[] = [];

function renderPicker(props: { sidebarOpen?: boolean; onToggleSidebar?: () => void }): string {
  return renderToString(
    <SessionPicker
      entries={[{ project, sessions, workers }]}
      error={null}
      selectedSessionId={null}
      sidebarOpen={props.sidebarOpen}
      onToggleSidebar={props.onToggleSidebar}
      onSelectSession={() => {}}
      onSelectProject={() => {}}
      onOpenSettings={() => {}}
      onSelectAllProjects={() => {}}
      onOpenGlobalSettings={() => {}}
      onStartOnboarding={() => {}}
      onStartOrchestrator={() => {}}
    />,
  );
}

describe("inline sidebar toggle (issues #354/#373)", () => {
  it("omits the toggle when no callback is wired (mobile drawer keeps the header hamburger)", () => {
    expect(renderPicker({})).not.toContain("sidebar-toggle");
  });

  it("lives on the workspace row (B21a) — the former top bar is gone", () => {
    const html = renderPicker({ sidebarOpen: true, onToggleSidebar: () => {} });
    expect(html).toContain("picker-global-row");
    expect(html).toContain("sidebar-toggle");
    // The toggle renders inside the workspace row, after its terminal-open
    // chat icon (the row's right edge) — no separate .picker-topbar.
    expect(html).not.toContain("picker-topbar");
    expect(html.indexOf("picker-global-row")).toBeLessThan(html.indexOf("sidebar-toggle"));
    expect(html.indexOf("picker-project-chat")).toBeLessThan(html.indexOf("sidebar-toggle"));
  });

  it("renders pointing left (expandable → collapsible) while open", () => {
    const html = renderPicker({ sidebarOpen: true, onToggleSidebar: () => {} });
    expect(html).toContain("‹");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Collapse the sidebar");
  });

  it("renders pointing right (reopen affordance) while collapsed", () => {
    const html = renderPicker({ sidebarOpen: false, onToggleSidebar: () => {} });
    expect(html).toContain("›");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Expand the sidebar");
  });
});
