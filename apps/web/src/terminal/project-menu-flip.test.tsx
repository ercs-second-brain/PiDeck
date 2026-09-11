/**
 * Issue #448 tests: the spawn-agent submenu's edge-overflow flip (B8) and
 * hover-to-open (B9). The flip probe reads getBoundingClientRect after
 * mount and hover is a real event, so these run under jsdom and drive the
 * real layout probe + events through `act` — unlike the SSR tests in
 * project-menu.test.tsx that cover the same menu's static markup.
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SHIPPED_AGENT_KINDS } from "@pideck/shared";
import { makeProject } from "./test-fixtures";
import { ProjectRow } from "./picker-rows";

const project = makeProject();

// ---------------------------------------------------------------------------
// Issue #448: edge-overflow flip (B8) + hover-to-open (B9). The flip probe
// reads getBoundingClientRect after mount, and hover is a real event, so
// unlike the SSR tests above this block runs under jsdom and drives the
// real layout probe + events through `act`.
// ---------------------------------------------------------------------------

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface StubRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** The anchor/submenu rects the stubbed geometry probe reports, keyed by class. */
function withStubbedGeometry(anchor: StubRect, submenu: StubRect, run: () => void): void {
  const proto = Element.prototype as unknown as { getBoundingClientRect: () => DOMRect };
  const original = proto.getBoundingClientRect.bind(proto);
  proto.getBoundingClientRect = function (this: Element) {
    const cls = this.classList;
    const rect = cls.contains("picker-submenu-anchor") ? anchor : cls.contains("picker-submenu") ? submenu : null;
    if (rect === null) return original();
    return { ...rect, x: rect.left, y: rect.top, width: rect.width, height: rect.height, toJSON: () => rect } as DOMRect;
  };
  const savedInner = { w: window.innerWidth, h: window.innerHeight };
  window.innerWidth = 1024;
  window.innerHeight = 768;
  try {
    run();
  } finally {
    proto.getBoundingClientRect = original;
    window.innerWidth = savedInner.w;
    window.innerHeight = savedInner.h;
  }
}

/** Renders the open project row (submenu expanded) with its callbacks. */
function renderOpenRow(overrides: Partial<Parameters<typeof ProjectRow>[0]> = {}): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const base = {
    projectName: project.name,
    projectId: project.id,
    hasOrchestrator: true,
    boardSelected: false,
    chatSelected: false,
    starting: false,
    collapsed: false,
    menuOpen: true,
    spawnSubmenuOpen: true,
    agentKinds: SHIPPED_AGENT_KINDS,
    onToggleCollapsed: () => {},
    onToggleMenu: () => {},
    onOpenSpawnSubmenu: () => {},
    onOpenSettings: () => {},
    onDeleteProject: () => {},
    onSpawnAgent: () => {},
    onAskSpawnInput: () => {},
    onStartOrchestrator: () => {},
    onSelectProject: () => {},
    ...overrides,
  };
  act(() => {
    root.render(<ProjectRow {...base} />);
  });
  return { container, root };
}

describe("spawn submenu edge-overflow flip (issue #448, B8)", () => {
  const roots: Root[] = [];
  const containers: HTMLElement[] = [];

  afterEach(() => {
    for (const r of roots) act(() => r.unmount());
    roots.length = 0;
    for (const c of containers) c.remove();
    containers.length = 0;
  });

  function renderWithGeometry(anchor: StubRect, submenu: StubRect): HTMLElement {
    let container!: HTMLElement;
    let root: Root | undefined;
    withStubbedGeometry(anchor, submenu, () => {
      const rendered = renderOpenRow({ spawnSubmenuOpen: true });
      container = rendered.container;
      root = rendered.root;
    });
    roots.push(root!);
    containers.push(container!);
    return container;
  }

  it("keeps the default (left-opening) placement when the viewport has room", () => {
    const container = renderWithGeometry(
      { left: 200, top: 100, right: 216, bottom: 128, width: 16, height: 28 },
      { left: 76, top: 100, right: 196, bottom: 260, width: 120, height: 160 },
    );
    const cls = container.querySelector(".picker-submenu")!.className;
    expect(cls).not.toContain("picker-submenu-flip");
  });

  it("flips to the anchor's right side when the left placement would overflow the left edge", () => {
    const container = renderWithGeometry(
      { left: 20, top: 100, right: 36, bottom: 128, width: 16, height: 28 },
      { left: 0, top: 100, right: 120, bottom: 260, width: 120, height: 160 },
    );
    const cls = container.querySelector(".picker-submenu")!.className;
    expect(cls).toContain("picker-submenu-flip-right");
    expect(cls).not.toContain("picker-submenu-flip-bottom");
  });

  it("extends upward when the top-aligned placement would overflow the bottom edge", () => {
    const container = renderWithGeometry(
      { left: 300, top: 700, right: 316, bottom: 730, width: 16, height: 30 },
      { left: 176, top: 700, right: 296, bottom: 900, width: 120, height: 200 },
    );
    const cls = container.querySelector(".picker-submenu")!.className;
    expect(cls).toContain("picker-submenu-flip-bottom");
    expect(cls).not.toContain("picker-submenu-flip-right");
  });
});

describe("spawn submenu opens on hover (issue #448, B9)", () => {
  const roots: Root[] = [];
  const containers: HTMLElement[] = [];

  afterEach(() => {
    for (const r of roots) act(() => r.unmount());
    roots.length = 0;
    for (const c of containers) c.remove();
    containers.length = 0;
  });

  it("fires the hover-open callback when the parent item is hovered", () => {
    const onHover = vi.fn();
    const { container } = renderOpenRow({ spawnSubmenuOpen: false, onHoverSpawnSubmenu: onHover });
    const toggle = [...container.querySelectorAll("button")].find((b) => b.textContent === "Spawn agent ▸");
    expect(toggle).toBeDefined();
    // React synthesizes onMouseEnter from delegated mouseover events.
    act(() => {
      toggle!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(onHover).toHaveBeenCalledTimes(1);
    // Hover alone does not expand the submenu — the parent's state decides.
    expect(container.querySelector(".picker-submenu")).toBeNull();
  });
});
