// @vitest-environment jsdom

/**
 * Route tests for <SessionPane />: live sessions keep the browser terminal,
 * archived ones render the log viewer. The Terminal and xterm modules are
 * fakes so neither pane opens real resources.
 */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "../test-support/websocket";
import { makeView } from "./test-support";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  api: vi.fn(async () => ({ log: "pane log\n" })),
}));

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: FakeFitAddon }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: FakeWebglAddon }));
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: FakeCanvasAddon }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: FakeUnicode11Addon }));

class FakeTerminal {
  static instances: FakeTerminal[] = [];
  options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  buffer = { active: { viewportY: 0, baseY: 24 } };
  constructor(options: Record<string, unknown>) {
    this.options = options;
    FakeTerminal.instances.push(this);
  }
  loadAddon() {}
  open() {}
  unicode = { activeVersion: "" };
  write() {}
  onData() {
    return { dispose: () => {} };
  }
  onScroll() {
    return { dispose: () => {} };
  }
  dispose() {}
}
class FakeFitAddon {
  fit() {}
}
class FakeWebglAddon {
  onContextLoss() {}
}
class FakeCanvasAddon {}
class FakeUnicode11Addon {}

const { SessionPane } = await import("./SessionPane");

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

beforeEach(() => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => host?.root.unmount());
  host = null;
});

describe("SessionPane", () => {
  it("renders the log viewer for an archived session", async () => {
    const container = mount(
      <SessionPane sessionId="s1" views={[makeView({ archivedAt: new Date().toISOString() })]} projects={[]} />,
    );
    await act(async () => {});
    expect(container.querySelector(".log-pane")).not.toBeNull();
  });

  it("keeps the live terminal for a session that is not archived", async () => {
    const container = mount(<SessionPane sessionId="s1" views={[makeView()]} projects={[]} />);
    await act(async () => {});
    expect(container.querySelector(".terminal-pane")).not.toBeNull();
  });

  it("keeps the live terminal while the session list has not loaded yet", async () => {
    const container = mount(<SessionPane sessionId="s1" views={[]} projects={[]} />);
    await act(async () => {});
    expect(container.querySelector(".terminal-pane")).not.toBeNull();
  });
});