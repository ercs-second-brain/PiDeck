/**
 * Tests for the project row's ⋯ context menu (issues #167/#172): every
 * project row in the sidebar carries a ⋯ toggle whose menu opens that
 * project's settings in the main pane and offers "Delete project…" (with a
 * confirmation modal stating the GitHub repo is kept). Row click opens the
 * project's kanban board (issue #173), and kanban is not duplicated into
 * the menu — it is already the row's name click. The row/menu/modal pieces
 * are pure, so they are exercised directly without xterm or effects.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { makeProject } from "./test-fixtures";
import { DeleteProjectModal, ProjectRow } from "./picker-rows";

const project = makeProject();

function renderRow(menuOpen: boolean): string {
  return renderToString(
    <ProjectRow
      projectName={project.name}
      projectId={project.id}
      hasOrchestrator
      boardSelected={false}
      chatSelected={false}
      starting={false}
      collapsed={false}
      menuOpen={menuOpen}
      onToggleCollapsed={() => {}}
      onToggleMenu={() => {}}
      onOpenSettings={() => {}}
      onDeleteProject={() => {}}
      onStartOrchestrator={() => {}}
      onSelectProject={() => {}}
    />,
  );
}

describe("project row ⋯ context menu (issue #167)", () => {
  it("gives each project row a ⋯ context-menu toggle", () => {
    const html = renderRow(false);
    expect(html).toContain("aria-haspopup=\"menu\"");
    expect(html).toContain("title=\"agentsKISS options\"");
    // Closed by default — no menu renders until the ⋯ toggle is clicked.
    expect(html).not.toContain("role=\"menu\"");
  });

  it("offers Settings in the open menu without duplicating the kanban entry", () => {
    const html = renderRow(true);
    expect(html).toContain("role=\"menu\"");
    expect(html).toContain(">Settings</button>");
    expect(html).toContain("Open agentsKISS&#x27;s settings");
    // Kanban stays the row's name click (#173) — the menu does not repeat it.
    expect(html).not.toContain(">Open board</button>");
  });

  it("keeps the project-name click the kanban entry and the chat icon the orchestrator entry (issue #173)", () => {
    const html = renderRow(true);
    expect(html).toContain("Open agentsKISS&#x27;s kanban board");
    expect(html).toContain("picker-project-name");
    // Issue #173: the row icon is a chat bubble that attaches/starts the
    // orchestrator's pi terminal (the #53 affordance).
    expect(html).toContain("picker-project-chat");
    expect(html).toContain("Attach agentsKISS&#x27;s orchestrator terminal");
  });
});

describe("Delete project… menu entry (issue #172)", () => {
  it("offers a destructive Delete project entry in the open menu", () => {
    const html = renderRow(true);
    expect(html).toContain(">Delete project…</button>");
    expect(html).toContain("the GitHub repo is kept");
  });

  it("renders the confirmation modal naming the project and sparing the GitHub repo", () => {
    const html = renderToString(
      <DeleteProjectModal projectName={project.name} pending={false} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(html).toContain("Delete project?");
    expect(html).toContain("<code>agentsKISS</code>");
    expect(html).toContain("The GitHub repository is not deleted.");
    expect(html).toContain("<strong>The GitHub repository is not deleted.</strong>");
    // The confirm button names the project explicitly (#172's "Delete [name]").
    expect(html).toContain(">Delete agentsKISS</button>");
    expect(html).toContain(">Cancel</button>");
  });

  it("disables interactions and shows progress while the delete is in flight", () => {
    const html = renderToString(
      <DeleteProjectModal
        projectName={project.name}
        pending
        error={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("Deleting…");
    expect(html).toContain("disabled");
  });

  it("surfaces a rejected delete (the 409 active-worker guard) inside the modal", () => {
    const html = renderToString(
      <DeleteProjectModal
        projectName={project.name}
        pending={false}
        error="project &quot;x&quot; has 1 active worker(s) driving PR (#7) — terminate or finish them before deleting"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("terminate-modal-error");
    expect(html).toContain("active worker(s) driving PR");
  });
});
