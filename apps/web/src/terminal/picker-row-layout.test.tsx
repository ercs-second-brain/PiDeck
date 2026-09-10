/**
 * Issue #373 sidebar row-layout contracts. B20: on the workspace and
 * project rows the terminal-open buttons (the 💬 chat icons) sit on the
 * LEFT, immediately after the row's name, while the ⋯ context menu alone
 * keeps the row's far right. B21a/B21b: the desktop collapse toggle lives
 * on the workspace row, and the collapsed 34px rail keeps that toggle as
 * the sidebar's only visible control. The rows are pure (markup-order
 * assertions via renderToString); the placement rules live in terminal.css,
 * pinned here as source contracts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { SHIPPED_AGENT_KINDS } from "@pideck/shared";
import { makeProject } from "./test-fixtures";
import { ProjectRow, SidebarToggle } from "./picker-rows";
import { GlobalAgentRow } from "./GlobalAgentRow";

const project = makeProject();

/** The terminal.css source (relative to this test file). */
const css = readFileSync(fileURLToPath(new URL("./terminal.css", import.meta.url)), "utf8");

/** The first `selector { … }` block in the CSS source, if present. */
function cssBlock(selector: string): string {
  const block = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1];
  if (block === undefined) throw new Error(`missing CSS block for ${selector}`);
  return block;
}

function renderProjectRow(): string {
  return renderToString(
    <ProjectRow
      projectName={project.name}
      projectId={project.id}
      hasOrchestrator
      boardSelected={false}
      chatSelected={false}
      starting={false}
      collapsed={false}
      menuOpen={false}
      spawnSubmenuOpen={false}
      agentKinds={SHIPPED_AGENT_KINDS}
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

function renderWorkspaceRow(): string {
  return renderToString(
    <GlobalAgentRow
      session={null}
      selected={false}
      boardSelected={false}
      disabled={false}
      starting={false}
      onSelectBoard={() => {}}
      onStart={() => {}}
      toggle={<SidebarToggle open onToggle={() => {}} />}
    />,
  );
}

describe("terminal-open buttons beside the name (issue #373 B20)", () => {
  it("workspace row: the name, then the terminal-open chat icon, then the collapse toggle", () => {
    const html = renderWorkspaceRow();
    expect(html).toContain("picker-global-name");
    expect(html).toContain("picker-project-chat");
    expect(html.indexOf("picker-global-name")).toBeLessThan(html.indexOf("picker-project-chat"));
    expect(html.indexOf("picker-project-chat")).toBeLessThan(html.indexOf("sidebar-toggle"));
  });

  it("project row: the name, then the terminal-open chat icon, with the ⋯ menu last", () => {
    const html = renderProjectRow();
    expect(html.indexOf("picker-project-name")).toBeLessThan(html.indexOf("picker-project-chat"));
    expect(html.indexOf("picker-project-chat")).toBeLessThan(html.indexOf("picker-project-menu"));
  });

  it("CSS keeps the ⋯ menu alone at the row's far right while the name hugs the icon", () => {
    // The name must not grow (that would push the chat icon to the menu) …
    expect(cssBlock(".picker-project-name")).toContain("flex: 0 1 auto");
    expect(cssBlock(".picker-project-name")).not.toContain("flex: 1");
    // … and the auto left margin is what pushes the ⋯ menu to the far right
    // (scanned: the selector first appears in the shared chat/menu rule).
    expect(css).toMatch(/\.picker-project-menu\s*\{[^}]*margin-left:\s*auto/);
  });
});

describe("collapsed desktop rail keeps the toggle (issue #373 B21a/B21b)", () => {
  const desktopRail = css.slice(css.indexOf("@media (min-width: 769px)"));

  it("the collapsed rail hides every scroll-region child except the workspace row", () => {
    expect(desktopRail).toContain(".picker-scroll > :not(.picker-global-row)");
  });

  it("inside the surviving workspace row only the toggle stays visible", () => {
    expect(desktopRail).toContain(".picker-global-row > :not(.sidebar-toggle)");
  });

  it("the toggle itself is never hidden by the collapsed-rail rules (the way back stays visible)", () => {
    // The `:not(.sidebar-toggle)` hide-everything-else rule mentions the
    // toggle; the assertion must still catch a rule targeting the toggle
    // element itself, so the match excludes `:not(...)` wrapping.
    expect(desktopRail).not.toMatch(
      /\.app:not\(\.sidebar-open\) [^{]*(?<!:not)\.sidebar-toggle(?!\))[^{]*\{[^}]*display:\s*none/,
    );
  });

  it("the former top bar is gone and the drawer breakpoint hides the toggle instead", () => {
    expect(css).not.toContain("picker-topbar");
    const drawer = css.slice(css.indexOf("@media (max-width: 768px)"));
    expect(drawer).toMatch(/\.sidebar-toggle\s*\{[^}]*display:\s*none/);
  });
});
