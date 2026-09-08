/**
 * Tests for the project row's ⋯ context menu (issue #167): every project
 * row in the sidebar carries a ⋯ toggle whose menu opens that project's
 * settings in the main pane. Row click stays the orchestrator entry
 * (issue #108), and kanban is not duplicated into the menu — it is already
 * the row's board icon. The row/menu pieces are pure, so they are
 * exercised directly without xterm or effects.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { Project } from "@pideck/shared";
import { ProjectRow } from "./picker-rows";

const project: Project = {
  id: "agentskiss",
  name: "agentsKISS",
  repoUrl: "https://github.com/ercs-second-brain/agentsKISS",
  defaultBranch: "main",
  settings: { autoAgentUsername: null, workerConcurrency: 2 },
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

function renderRow(menuOpen: boolean): string {
  return renderToString(
    <ProjectRow
      projectName={project.name}
      projectId={project.id}
      hasOrchestrator
      orchestratorSelected={false}
      boardSelected={false}
      starting={false}
      collapsed={false}
      menuOpen={menuOpen}
      onToggleCollapsed={() => {}}
      onToggleMenu={() => {}}
      onOpenSettings={() => {}}
      onStartOrchestrator={() => {}}
      onSelectProject={() => {}}
    />,
  );
}

describe("project row ⋯ context menu (issue #167)", () => {
  it("gives each project row a ⋯ context-menu toggle", () => {
    const html = renderRow(false);
    expect(html).toContain("picker-project-menu");
    expect(html).toContain("aria-haspopup=\"menu\"");
    // Closed by default — no menu renders until the ⋯ toggle is clicked.
    expect(html).not.toContain("picker-context-menu");
  });

  it("offers Settings in the open menu without duplicating the kanban icon", () => {
    const html = renderRow(true);
    expect(html).toContain("picker-context-menu");
    expect(html).toContain(">Settings</button>");
    expect(html).toContain("Open agentsKISS&#x27;s settings");
    // Kanban stays the row's board icon (#108) — the menu does not repeat it.
    expect(html).not.toContain(">Open board</button>");
  });

  it("keeps the project-name click the orchestrator entry (issue #108)", () => {
    const html = renderRow(true);
    expect(html).toContain("Attach agentsKISS&#x27;s orchestrator terminal");
    expect(html).toContain("picker-project-name");
  });
});
