/**
 * Issue #354: the sidebar's inline collapse toggle (desktop). When the shell
 * wires `onToggleSidebar`, the sidebar renders a small toggle icon at its
 * top right — pointing left while open, right while collapsed — replacing
 * the header hamburger on desktop (which stays mobile-only, CSS-side). Pure
 * render tests: the toggle's presence, direction, and aria state.
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

describe("inline sidebar toggle (issue #354)", () => {
  it("omits the toggle when no callback is wired (mobile drawer keeps the header hamburger)", () => {
    const html = renderToString(
      <SessionPicker
        entries={[{ project, sessions, workers }]}
        error={null}
        selectedSessionId={null}
        onSelectSession={() => {}}
        onSelectProject={() => {}}
        onOpenSettings={() => {}}
        onSelectAllProjects={() => {}}
        onOpenGlobalSettings={() => {}}
        onStartOnboarding={() => {}}
        onStartOrchestrator={() => {}}
      />,
    );
    expect(html).not.toContain("sidebar-toggle");
    expect(html).not.toContain("picker-topbar");
  });

  it("renders pointing left (expandable → collapsible) while open", () => {
    const html = renderToString(
      <SessionPicker
        entries={[{ project, sessions, workers }]}
        error={null}
        selectedSessionId={null}
        sidebarOpen={true}
        onToggleSidebar={() => {}}
        onSelectSession={() => {}}
        onSelectProject={() => {}}
        onOpenSettings={() => {}}
        onSelectAllProjects={() => {}}
        onOpenGlobalSettings={() => {}}
        onStartOnboarding={() => {}}
        onStartOrchestrator={() => {}}
      />,
    );
    expect(html).toContain("picker-topbar");
    expect(html).toContain("sidebar-toggle");
    expect(html).toContain("‹");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Collapse the sidebar");
  });

  it("renders pointing right (reopen affordance) while collapsed", () => {
    const html = renderToString(
      <SessionPicker
        entries={[{ project, sessions, workers }]}
        error={null}
        selectedSessionId={null}
        sidebarOpen={false}
        onToggleSidebar={() => {}}
        onSelectSession={() => {}}
        onSelectProject={() => {}}
        onOpenSettings={() => {}}
        onSelectAllProjects={() => {}}
        onOpenGlobalSettings={() => {}}
        onStartOnboarding={() => {}}
        onStartOrchestrator={() => {}}
      />,
    );
    expect(html).toContain("›");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Expand the sidebar");
  });
});
