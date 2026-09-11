/**
 * Issue #373 sidebar row-layout contracts, placement reversed by issue #449
 * (B10): on the workspace and project rows the 💬 terminal-open button sits
 * on the RIGHT, adjacent to the row's existing right-side control (the ⋯
 * context menu on project rows, the desktop collapse toggle on the
 * workspace row) — one icon cluster at the far right, the row name clean on
 * the left. B21a/B21b: the desktop collapse toggle lives on the workspace
 * row, and the collapsed 34px rail keeps that toggle as the sidebar's only
 * visible control. The rows are pure (markup-order assertions via
 * renderToString); the placement rules live in terminal.css, pinned here as
 * source contracts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { SHIPPED_AGENT_KINDS } from "@pideck/shared";
import { makeProject, makeSession, makeWorker } from "./test-fixtures";
import { ProjectRow, SidebarToggle, WorkerRow } from "./picker-rows";
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

describe("terminal-open buttons beside the name (issue #373 B20; right-clustered per #449 B10)", () => {
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

  it("CSS keeps the ⋯ menu far right with the chat icon clustered beside it (issue #449 B10)", () => {
    // The name must not grow (that would drag the cluster apart) …
    expect(cssBlock(".picker-project-name")).toContain("flex: 0 1 auto");
    expect(cssBlock(".picker-project-name")).not.toContain("flex: 1");
    // … and the auto left margin now lives on the 💬 chat icon: it pushes
    // the right-hand icon cluster (💬 + ⋯, or 💬 + collapse toggle on the
    // workspace row) to the row's far right.
    expect(cssBlock(".picker-project-chat")).toContain("margin-left: auto");
    // The ⋯ menu keeps only its dropdown anchor — no margin of its own.
    expect(cssBlock(".picker-project-menu")).not.toContain("margin-left");
    expect(css).toMatch(/\.picker-project-menu\s*\{[^}]*position:\s*relative/);
  });
});

describe("worker row ⋯ menu presence + geometry (issue #482)", () => {
  const session = makeSession({ tmuxSession: "agentskiss-worker-a" });
  const worker = makeWorker();

  function renderWorkerRow(withRecord: boolean): string {
    return renderToString(
      <WorkerRow
        session={session}
        workers={withRecord ? [worker] : []}
        archived={false}
        selectedSessionId={null}
        pending={false}
        onSelectSession={() => {}}
        onTerminateWorker={async () => {}}
        onAskTerminate={() => {}}
        onToggleRowMenu={() => {}}
      />,
    );
  }

  it("every wired live worker row carries the ⋯ toggle — with or without a worker record", () => {
    expect(renderWorkerRow(true)).toContain("picker-row-menu-toggle");
    // Issue #482: an adopted orphan session (no worker record — startup
    // adoption after a restart whose state was lost, or an empty workers
    // fetch) keeps the affordance instead of silently dropping it.
    expect(renderWorkerRow(false)).toContain("picker-row-menu-toggle");
  });

  it("the session button comes first, the ⋯ menu anchor is the row's last flex child", () => {
    for (const withRecord of [true, false]) {
      const html = renderWorkerRow(withRecord);
      expect(html.indexOf("picker-session")).toBeLessThan(html.indexOf("picker-row-menu-anchor"));
      expect(html.indexOf("picker-row-menu-anchor")).toBeLessThan(html.lastIndexOf("</li>"));
    }
  });

  it("CSS anchors the ⋯ toggle at the row's right edge (worker rows have no chat icon)", () => {
    // Worker rows have no 💬 chat icon, so the right-edge anchor is the
    // session button itself: it grows to fill the row (flex: 1, shrinkable
    // via min-width: 0) and pushes the fixed-size menu anchor against the
    // row's far right. #449 moved the auto margin onto the chat icon of
    // project/workspace rows — this contract pins the worker rows' anchor.
    const sessionBlock = cssBlock(".picker-worker-row .picker-session");
    expect(sessionBlock).toContain("flex: 1");
    expect(sessionBlock).toContain("min-width: 0");
    // The anchor wraps toggle + dropdown, never grows, never displaces.
    const anchorBlock = cssBlock(".picker-row-menu-anchor");
    expect(anchorBlock).toContain("flex: none");
    expect(anchorBlock).toContain("position: relative");
    // The toggle keeps its 26px icon-button box and is never display-hidden.
    const toggleBlock = cssBlock(".picker-row-menu-toggle");
    expect(toggleBlock).toContain("width: 26px");
    expect(toggleBlock).not.toContain("display: none");
  });

  it("the mobile drawer breakpoint keeps the toggle finger-sized, not hidden", () => {
    const drawer = css.slice(css.indexOf("@media (max-width: 768px)"));
    expect(drawer).toMatch(/\.picker-row-menu-toggle\s*\{[^}]*width:\s*40px/);
    expect(drawer).toMatch(/\.picker-row-menu-toggle\s*\{[^}]*height:\s*40px/);
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
