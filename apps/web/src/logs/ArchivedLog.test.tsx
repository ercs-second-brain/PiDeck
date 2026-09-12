// @vitest-environment jsdom

/**
 * Component tests for the <ArchivedLog /> viewer: the xterm modules are
 * fakes (no canvas in jsdom) and the api client is mocked, so the fetch →
 * render → teardown lifecycle runs for real.
 */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@pideck/shared";
import { makeView } from "./test-support";
import { TERMINAL_THEME } from "../terminal/terminal-theme";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
      this.name = "ApiError";
    }
  },
  api: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: FakeFitAddon }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: FakeWebglAddon }));
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: FakeCanvasAddon }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: FakeUnicode11Addon }));

class FakeTerminal {
  static instances: FakeTerminal[] = [];
  static reset() {
    FakeTerminal.instances = [];
  }
  options: Record<string, unknown>;
  written = "";
  dataHandlers: ((data: unknown) => void)[] = [];
  disposed = false;
  constructor(options: Record<string, unknown>) {
    this.options = options;
    FakeTerminal.instances.push(this);
  }
  loadAddon() {}
  open() {}
  unicode = { activeVersion: "" };
  write(data: string) {
    this.written += data;
  }
  onData(handler: (data: unknown) => void) {
    this.dataHandlers.push(handler);
    return { dispose: () => {} };
  }
  dispose() {
    this.disposed = true;
  }
}

class FakeFitAddon {
  fit() {}
}
class FakeWebglAddon {
  onContextLoss() {}
}
class FakeCanvasAddon {}
class FakeUnicode11Addon {}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(public callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe() {}
  disconnect() {}
}

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

function stubGlobals() {
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const { ArchivedLog } = await import("./ArchivedLog");
const { api, ApiError } = await import("../lib/api");

const apiMock = vi.mocked(api);

const project: Project = {
  id: "p1",
  name: "my-api",
  repoUrl: "https://github.com/acme/my-api",
  owner: "acme",
  repo: "my-api",
  defaultBranch: "main",
  path: "/srv/my-api",
};

let host: { root: Root; container: HTMLElement } | null = null;

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  host = { root, container };
  act(() => {
    root.render(element);
  });
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {});
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  FakeTerminal.instances = [];
  FakeResizeObserver.instances = [];
  stubGlobals();
});

afterEach(() => {
  act(() => host?.root.unmount());
  host = null;
});

describe("ArchivedLog", () => {
  it("renders metadata and writes the captured log into a read-only terminal", async () => {
    const view = makeView({ issueNumber: 42, prNumber: 43, archivedAt: new Date().toISOString() });
    apiMock.mockResolvedValue({ log: "\x1b[32mbuild ok\x1b[0m\n" });
    const container = mount(<ArchivedLog sessionId="s1" view={view} project={project} />);
    await flush();

    expect(apiMock).toHaveBeenCalledWith("sessionLog", { id: "s1" });
    expect(container.textContent).toContain("Worker");
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://github.com/acme/my-api/issues/42",
      "https://github.com/acme/my-api/pull/43",
    ]);
    expect(container.textContent).toContain("spawned 1h");
    expect(container.textContent).toContain("archived now");
    expect(container.textContent).toContain("done");

    const term = FakeTerminal.instances[0];
    if (!term) throw new Error("no terminal mounted");
    expect(term.options.theme).toBe(TERMINAL_THEME);
    expect(term.written).toBe("\x1b[32mbuild ok\x1b[0m\n");
    // Read-only: the pane registers no input path.
    expect(term.dataHandlers.length).toBe(0);
    expect(term.options.cursorBlink).toBe(false);
  });

  it("shows an empty state when no log was captured", async () => {
    const view = makeView({ archivedAt: new Date().toISOString() });
    apiMock.mockRejectedValue(new (ApiError as new (status: number, message: string) => Error)(404, "no log"));
    const container = mount(<ArchivedLog sessionId="s1" view={view} project={null} />);
    await flush();

    expect(FakeTerminal.instances.length).toBe(0);
    expect(container.textContent).toContain("No log was captured for this session.");
  });

  it("offers a retry after a failed load and recovers", async () => {
    const view = makeView({ archivedAt: new Date().toISOString() });
    apiMock.mockRejectedValueOnce(new (ApiError as new (status: number, message: string) => Error)(500, "boom"));
    apiMock.mockResolvedValueOnce({ log: "recovered\n" });
    const container = mount(<ArchivedLog sessionId="s1" view={view} project={null} />);
    await flush();

    expect(container.textContent).toContain("Cannot load the log.");
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry");
    expect(retry).toBeDefined();
    act(() => retry!.click());
    await flush();

    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(FakeTerminal.instances[0]?.written).toBe("recovered\n");
  });
});