// @vitest-environment jsdom
/**
 * Issue #492 regression test (finding B2): the spawn-agent submenu in the
 * project ⋯ menu "never appears". Root cause: since hover-to-open shipped
 * (issue #448, B9), a pointer user's click on "Spawn agent ▸" is always
 * preceded by the mouseenter that already opened the submenu — and the click
 * was still a TOGGLE, so it closed what the hover just opened. Click is now
 * an idempotent open (same as hover), so the submenu stays visible.
 *
 * These tests drive the real SessionPicker wiring (usePickerState state +
 * the SessionPicker → ProjectRow → ProjectMenu prop chain) under jsdom,
 * unlike the SSR markup tests in project-menu.test.tsx.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Worker } from "@pideck/shared";
import { makeProject, makeSession } from "./test-fixtures";
import { SessionPicker } from "./SessionPicker";

const project = makeProject();

const sessions = [
  makeSession({ id: "sess-orch-1", role: "orchestrator", tmuxSession: "pideck-agentskiss-orchestrator-1" }),
];

const workers: Worker[] = [];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const containers: HTMLElement[] = [];

afterEach(() => {
  for (const r of roots) act(() => r.unmount());
  roots.length = 0;
  for (const c of containers) c.remove();
  containers.length = 0;
});

/** Mounts the sidebar with one project and returns its DOM container. */
function renderPicker(onSpawnAgentSession?: (projectId: string, kind: string, question?: string) => Promise<void>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
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
        onSpawnAgentSession={onSpawnAgentSession}
      />,
    );
  });
  roots.push(root);
  containers.push(container);
  return container;
}

/** The project row's ⋯ toggle. */
function projectMenuToggle(container: HTMLElement): HTMLButtonElement {
  const toggle = container.querySelector<HTMLButtonElement>(".picker-project-menu");
  expect(toggle).not.toBeNull();
  return toggle!;
}

/** The open ⋯ menu's "Spawn agent ▸" toggle. */
function spawnToggle(container: HTMLElement): HTMLButtonElement {
  const toggle = [...container.querySelectorAll("button")].find((b) => b.textContent === "Spawn agent ▸");
  expect(toggle).toBeDefined();
  return toggle!;
}

describe("spawn submenu opens and stays open (issue #492)", () => {
  it("hover then click on Spawn agent leaves the submenu open (the #492 flash-and-close regression)", () => {
    const container = renderPicker();
    // Open the project's ⋯ menu.
    act(() => {
      projectMenuToggle(container).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("Settings");
    expect(container.querySelector(".picker-submenu")).toBeNull();

    // Pointer interaction: entering the item fires mouseenter (React
    // synthesizes it from the delegated mouseover) which opens the submenu…
    act(() => {
      spawnToggle(container).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(container.querySelector(".picker-submenu")).not.toBeNull();

    // …and the click that follows must NOT close it again (pre-#492 the
    // click toggled, undoing the hover-open: the submenu never appeared).
    act(() => {
      spawnToggle(container).click();
    });
    expect(container.querySelector(".picker-submenu")).not.toBeNull();
    expect(container.textContent).toContain("Researcher");
  });

  it("click alone (no hover — keyboard/touch) opens the submenu", () => {
    const container = renderPicker();
    act(() => {
      projectMenuToggle(container).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      spawnToggle(container).click();
    });
    expect(container.querySelector(".picker-submenu")).not.toBeNull();
    expect(container.textContent).toContain("Researcher");
  });

  it("clicking a kind entry spawns through the wired onSpawnAgentSession", async () => {
    const onSpawnAgentSession = vi.fn<(projectId: string, kind: string, question?: string) => Promise<void>>(
      () => Promise.resolve(),
    );
    const container = renderPicker(onSpawnAgentSession);
    act(() => {
      projectMenuToggle(container).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      spawnToggle(container).click();
    });
    // A waitForInput kind (researcher) opens the input modal; an auto kind
    // (devex-audit) spawns directly — pick the auto one for the spawn path.
    const devex = [...container.querySelectorAll<HTMLButtonElement>(".picker-submenu button")].find((b) => b.textContent === "Devex audit");
    expect(devex).toBeDefined();
    await act(async () => {
      devex!.click();
    });
    expect(onSpawnAgentSession).toHaveBeenCalledWith(project.id, "devex-audit", undefined);
    // The spawn closes the whole ⋯ menu (the footer's own ⚙ Settings stays).
    expect(container.querySelector(".picker-context-menu")).toBeNull();
  });
});