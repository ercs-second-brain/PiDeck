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
import { SHIPPED_AGENT_KINDS, type AgentKindSpec } from "@pideck/shared";
import { makeProject } from "./test-fixtures";
import { ProjectRow } from "./picker-rows";
import { DeleteProjectModal, SpawnInputModal } from "./picker-modals";

/** The shipped researcher spec (issue #351 F1: question wording follows the spec's trigger). */
const researcherSpec = SHIPPED_AGENT_KINDS.find((kind) => kind.name === "researcher");

const project = makeProject();

/** A user-defined kind (registry v2) exercising the submenu's custom group. */
const customKind: AgentKindSpec = {
  name: "deps-audit",
  label: "deps-audit",
  menuLabel: "Deps audit",
  description: "Spawn a deps audit — flags risky dependency drift for the orchestrator",
  spawnableBy: ["orchestrator"],
  callerWaits: false,
  readOnly: true,
  trigger: "waitForInput",
  reportTarget: "orchestrator",
  workerLike: false,
};

/** A kind reserved to worker callers — the project menu must not list it. */
const workerOnlyKind: AgentKindSpec = {
  ...customKind,
  name: "pair-helper",
  menuLabel: "Pair helper",
  description: "Spawn a pair helper",
  spawnableBy: ["worker"],
};

function renderRow(menuOpen: boolean, opts: { spawnSubmenuOpen?: boolean; agentKinds?: readonly AgentKindSpec[] } = {}): string {
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
      spawnSubmenuOpen={opts.spawnSubmenuOpen ?? false}
      agentKinds={opts.agentKinds ?? SHIPPED_AGENT_KINDS}
      onToggleCollapsed={() => {}}
      onToggleMenu={() => {}}
      onToggleSpawnSubmenu={() => {}}
      onOpenSettings={() => {}}
      onDeleteProject={() => {}}
      onSpawnAgent={() => {}}
      onAskSpawnInput={() => {}}
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

describe("Spawn agent submenu (docs/agent-kinds.md §8, issues #324/#330/#331)", () => {
  it("offers a closed Spawn agent submenu toggle in the open ⋯ menu", () => {
    const html = renderRow(true);
    expect(html).toContain("Spawn agent ▸");
    expect(html).toContain("aria-haspopup=\"true\"");
    expect(html).toContain("aria-expanded=\"false\"");
    // Closed by default — no kind entries render until it is expanded.
    expect(html).not.toContain(">Researcher</button>");
  });

  it("expands to the built-in kinds (no custom group when the registry has none)", () => {
    const html = renderRow(true, { spawnSubmenuOpen: true });
    expect(html).toContain("role=\"menu\"");
    expect(html).toContain(">Built-in</span>");
    expect(html).not.toContain(">Custom</span>");
    // Issue #309: no stray ellipsis — the label is a plain word.
    expect(html).toContain(">Researcher</button>");
    expect(html).not.toContain("Researcher…");
    expect(html).toContain(">Devex audit</button>");
    expect(html).toContain(">KISS audit</button>");
  });

  it("pops the submenu out of the menu as a flyout anchored to its toggle (issue #355, B6)", () => {
    const html = renderRow(true, { spawnSubmenuOpen: true });
    // The submenu renders inside the anchor wrapping its toggle — popped out, not in place.
    expect(html).toContain("picker-submenu-anchor");
    const anchor = html.slice(html.indexOf("picker-submenu-anchor"));
    expect(anchor).toContain("Spawn agent ▸");
    expect(anchor).toContain(">Built-in</span>");
  });

  it("states each kind's behavior in its menu title", () => {
    const html = renderRow(true, { spawnSubmenuOpen: true });
    expect(html).toContain("Spawn a researcher — it researches one question against the codebase and reports back");
    expect(html).toContain("Spawn a devex audit — mines prior sessions for friction, reports to the orchestrator");
    expect(html).toContain("Spawn a KISS audit — complexity findings, reported to the orchestrator");
  });

  it("groups user-defined kinds from the live registry under Custom (issue #330/#331)", () => {
    const html = renderRow(true, { spawnSubmenuOpen: true, agentKinds: [...SHIPPED_AGENT_KINDS, customKind] });
    expect(html).toContain(">Custom</span>");
    expect(html).toContain(">Deps audit</button>");
    // The custom kind's own behavior summary is its title.
    expect(html).toContain("Spawn a deps audit — flags risky dependency drift for the orchestrator");
  });

  it("hides kinds the project context may not spawn (spawnableBy honored)", () => {
    const html = renderRow(true, { spawnSubmenuOpen: true, agentKinds: [...SHIPPED_AGENT_KINDS, customKind, workerOnlyKind] });
    // The worker-only kind has no orchestrator role — not listed here (the
    // daemon remains the enforcement point, docs/agent-kinds.md §5).
    expect(html).not.toContain(">Pair helper</button>");
    expect(html).toContain(">Custom</span>"); // customKind is still listed
    expect(html).toContain(">Deps audit</button>");
  });

  it("renders the input modal for a waitForInput kind with its confirm disabled while empty", () => {
    const html = renderToString(
      <SpawnInputModal projectName={project.name} agentKind="researcher" spec={researcherSpec} pending={false} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(html).toContain("Spawn Researcher?");
    expect(html).toContain("<code>agentsKISS</code>");
    expect(html).toContain("aria-label=\"Researcher question\"");
    // Empty input in SSR: the confirm renders its label but stays disabled
    // (typing enables it client-side — the input state is client-only).
    expect(html).toContain(">Spawn</button>");
    expect(html).toContain("disabled");
  });

  it("derives the modal labels from the kind's shared metadata (issue #324)", () => {
    const html = renderToString(
      <SpawnInputModal projectName={project.name} agentKind="researcher" spec={researcherSpec} pending={false} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(html).toContain("aria-label=\"Spawn researcher\"");
    expect(html).toContain("aria-label=\"Researcher question\"");
  });

  it("derives question vs task wording from the spec's trigger, not the kind name (issue #351 F1)", () => {
    // A user-defined waitForInput kind asks a question — same as the researcher.
    const html = renderToString(
      <SpawnInputModal projectName={project.name} agentKind={customKind.name} spec={customKind} pending={false} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(html).toContain("Spawn Deps audit?");
    expect(html).toContain("aria-label=\"Deps audit question\"");
    expect(html).toContain("What should it research?");
    // An unresolvable spec (registry unfetched) falls back to task wording.
    const unknown = renderToString(
      <SpawnInputModal projectName="p" agentKind="mystery" pending={false} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(unknown).toContain("aria-label=\"mystery task\"");
    expect(unknown).toContain("Describe the task…");
  });

  it("drops the read-only claim for a spec that allows writes", () => {
    const writable: AgentKindSpec = { ...customKind, name: "fixer", readOnly: false, trigger: "waitForInput", spawnableBy: ["orchestrator"] };
    expect(renderToString(<SpawnInputModal projectName="p" agentKind={writable.name} spec={writable} pending={false} onConfirm={() => {}} onCancel={() => {}} />)).not.toContain("read-only");
    expect(renderToString(<SpawnInputModal projectName="p" agentKind={customKind.name} spec={customKind} pending={false} onConfirm={() => {}} onCancel={() => {}} />)).toContain("read-only");
  });

  it("shows the in-flight and failure states inside the input modal", () => {
    const pending = renderToString(
      <SpawnInputModal projectName="p" agentKind="researcher" pending onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(pending).toContain("Spawning…");
    const failed = renderToString(
      <SpawnInputModal projectName="p" agentKind="researcher" pending={false} error="agent sessions are not wired yet" onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(failed).toContain("terminate-modal-error");
    expect(failed).toContain("agent sessions are not wired yet");
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
