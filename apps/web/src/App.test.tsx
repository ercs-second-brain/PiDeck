// @vitest-environment jsdom

/**
 * Component test for the shell's live project list: the `projects.changed`
 * snapshots pushed through watchServer() update the sidebar without a page
 * reload, so a project added during onboarding appears immediately.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, SessionView } from "@pideck/shared";

type WatchHandlers = {
  onSessions: (sessions: SessionView[]) => void;
  onProjects: (projects: Project[]) => void;
};

const watchHandlers: Array<WatchHandlers | null> = [];

vi.mock("./lib/api", () => ({
  api: vi.fn(async (name: string) => {
    if (name === "status") {
      return {
        version: "0.0.0-test",
        stateDir: "/state",
        pollIntervalSeconds: 30,
        piReady: true,
        ghReady: true,
        github: { throttledUntil: null, lastError: null },
      };
    }
    if (name === "projectList") return [];
    if (name === "sessionList") return [];
    throw new Error(`unexpected endpoint: ${name}`);
  }),
  watchServer: vi.fn((handlers: WatchHandlers) => {
    watchHandlers[0] = handlers;
    return () => {};
  }),
}));

import { App } from "./App";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT: Project = {
  id: "p1",
  name: "my-api",
  repoUrl: "https://github.com/acme/my-api",
  owner: "acme",
  repo: "my-api",
  defaultBranch: "main",
  path: "/repos/my-api",
};

const roots: Root[] = [];

async function mountApp(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<App />);
  });
  return container;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
  watchHandlers[0] = null;
  vi.resetAllMocks();
});

describe("<App />", () => {
  it("adds a project to the sidebar live when projects.changed arrives", async () => {
    const container = await mountApp();
    expect(container.textContent).toContain("No projects yet.");

    await act(async () => {
      watchHandlers[0]?.onProjects([PROJECT]);
    });
    const projectRow = container.querySelector(".sidebar__project .srow__label");
    expect(projectRow?.textContent).toBe("my-api");
    expect(container.textContent).not.toContain("No projects yet.");

    await act(async () => {
      watchHandlers[0]?.onProjects([]);
    });
    expect(container.querySelector(".sidebar__project")).toBeNull();
  });
});
