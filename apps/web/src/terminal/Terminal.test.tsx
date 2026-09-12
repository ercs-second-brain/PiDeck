// @vitest-environment jsdom

/**
 * Component tests for the <Terminal sessionId /> pane: xterm.js bound to the
 * WebSocket terminal protocol. The xterm modules are fakes (no canvas in
 * jsdom) and the WebSocket is a fake, so the full mount → attach → stream →
 * reconnect lifecycle runs for real.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "../test-support/websocket";

// -- Fakes for the xterm browser modules -------------------------------------

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: FakeFitAddon }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: FakeWebglAddon }));
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: FakeCanvasAddon }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: FakeUnicode11Addon }));

// vi.mock factories are hoisted — the fake classes are created there.
type FakeHandler = (data: unknown) => void;

class FakeTerminal {
  static instances: FakeTerminal[] = [];
  static reset() {
    FakeTerminal.instances = [];
  }
  options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  written = "";
  resets = 0;
  scrolledToBottom = 0;
  buffer = { active: { viewportY: 0, baseY: 24 } };
  dataHandlers: FakeHandler[] = [];
  scrollHandlers: FakeHandler[] = [];
  textarea: { focus: (options?: { preventScroll?: boolean }) => void } | null = null;
  element: { querySelector: (selector: string) => unknown } | null = null;
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
  reset() {
    this.resets += 1;
    this.written = "";
  }
  onData(handler: FakeHandler) {
    this.dataHandlers.push(handler);
    return { dispose: () => {} };
  }
  onScroll(handler: FakeHandler) {
    this.scrollHandlers.push(handler);
    return { dispose: () => {} };
  }
  scrollToBottom() {
    this.scrolledToBottom += 1;
    this.buffer.active.viewportY = this.buffer.active.baseY;
    this.scrollHandlers.forEach((handler) => handler(0));
  }
  focus() {}
  dispose() {
    this.disposed = true;
  }
  emitData(data: string) {
    for (const handler of [...this.dataHandlers]) handler(data);
  }
  fireScroll() {
    for (const handler of [...this.scrollHandlers]) handler(0);
  }
}

class FakeFitAddon {
  static last: FakeFitAddon | null = null;
  /** Optional stand-in for the fit addon's measurement; mutates the fake
   *  terminal's cols/rows like a real fit would. Default: no-op (80x24). */
  static fitImpl: (() => void) | null = null;
  constructor() {
    FakeFitAddon.last = this;
  }
  fit() {
    FakeFitAddon.fitImpl?.();
  }
}

class FakeWebglAddon {
  onContextLoss() {}
}
class FakeCanvasAddon {}
class FakeUnicode11Addon {}

// -- Fake WebSocket -----------------------------------------------------------

// -- Mounting helpers ----------------------------------------------------------

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(public callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe() {}
  disconnect() {}
}

/** Controllable animation frames: callbacks run via flushFrames(). */
let rafQueue: Map<number, FrameRequestCallback>;
let nextRafId: number;
function flushFrames(): void {
  const pending = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of pending) cb(16);
}

declare global {
   
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

function stubGlobals() {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  rafQueue = new Map();
  nextRafId = 1;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextRafId++;
    rafQueue.set(id, cb);
    return id;
  };
  globalThis.cancelAnimationFrame = (id: number) => {
    rafQueue.delete(id);
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const { Terminal } = await import("./Terminal");

/** The mounted terminal instance, or a loud failure naming the real problem. */
function mountedTerminal(): FakeTerminal {
  const term = FakeTerminal.instances[0];
  if (!term) throw new Error("no terminal mounted");
  return term;
}

function mount(sessionId: string): { root: Root; container: HTMLElement } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Terminal sessionId={sessionId} />);
  });
  return { root, container };
}

let host: { root: Root; container: HTMLElement } | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  FakeTerminal.reset();
  FakeWebSocket.reset();
  FakeResizeObserver.instances = [];
  FakeFitAddon.last = null;
  FakeFitAddon.fitImpl = null;
  stubGlobals();
});

afterEach(() => {
  act(() => host?.root.unmount());
  host = null;
  vi.useRealTimers();
});

/** Runs the pending socket open (and anything the mount effect queued). */
function connect(index = 0): FakeWebSocket {
  const ws = FakeWebSocket.instances[index];
  if (!ws) throw new Error(`no socket #${index}`);
  act(() => {
    ws.open();
  });
  return ws;
}

describe("<Terminal />", () => {
  it("creates the xterm surface with the designed configuration", () => {
    host = mount("s1");
    const term = mountedTerminal();
    expect(term).toBeDefined();
    expect(term.options).toMatchObject({
      allowProposedApi: true,
      cursorBlink: true,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
      scrollback: 5000,
      fontSize: 13,
      lineHeight: 1.35,
    });
    expect(term.unicode.activeVersion).toBe("11");
  });

  it("connects to /ws and attaches the session with its pane size", () => {
    host = mount("s1");
    const ws = connect();
    expect(ws.url).toBe("ws://localhost:3000/ws");
    expect(ws.lastFrame).toEqual({ type: "terminal.attach", sessionId: "s1", cols: 80, rows: 24 });
    expect(host.container.querySelector(".terminal-status")).toBeNull();
  });

  it("attaches with the post-fit size: the fit runs before the attach frame", () => {
    // The fit measures the container and resizes xterm before attach is sent.
    FakeFitAddon.fitImpl = () => {
      const term = FakeTerminal.instances[0];
      if (term) {
        term.cols = 123;
        term.rows = 42;
      }
    };
    host = mount("s1");
    const ws = connect();
    expect(ws.lastFrame).toEqual({ type: "terminal.attach", sessionId: "s1", cols: 123, rows: 42 });
  });

  it("re-fits on the next animation frame after a replay and propagates the new size", () => {
    host = mount("s1");
    connect();
    // The layout settles while the pane is attached: the fit now measures a
    // wider container.
    FakeFitAddon.fitImpl = () => {
      const term = FakeTerminal.instances[0];
      if (term) {
        term.cols = 140;
        term.rows = 44;
      }
    };
    act(() => {
      FakeWebSocket.instances[0]?.drop();
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    const ws = connect(1); // onReplay schedules the next-frame re-fit
    act(() => {
      flushFrames();
    });
    expect(ws.frames).toEqual([
      { type: "terminal.attach", sessionId: "s1", cols: 80, rows: 24 },
      { type: "terminal.resize", sessionId: "s1", cols: 140, rows: 44 },
    ]);
  });

  it("cancels the pending next-frame re-fit on unmount", () => {
    FakeFitAddon.fitImpl = () => {
      const term = FakeTerminal.instances[0];
      if (term) {
        term.cols = 140;
        term.rows = 44;
      }
    };
    host = mount("s1");
    connect();
    act(() => {
      host?.root.unmount();
    });
    host = null;
    act(() => {
      flushFrames();
    });
    // The cancelled frame must not fit the disposed terminal.
    expect(FakeTerminal.instances[0]?.disposed).toBe(true);
  });

  it("resets the pane before the replay and streams terminal.data into xterm", () => {
    host = mount("s1");
    const term = mountedTerminal();
    const ws = connect();
    act(() => {
      ws.serverSends({ type: "terminal.data", sessionId: "s1", data: "hello " });
    });
    expect(term.written).toBe("hello ");
    expect(term.resets).toBe(1);
  });

  it("sends keystrokes as terminal.data frames", () => {
    host = mount("s1");
    const term = mountedTerminal();
    connect();
    act(() => {
      term.emitData("ls\r");
    });
    expect(FakeWebSocket.instances[0]?.lastFrame).toEqual({
      type: "terminal.data",
      sessionId: "s1",
      data: "ls\r",
    });
  });

  it("shows a small disconnected pill while connecting and reconnecting", () => {
    host = mount("s1");
    expect(host.container.querySelector(".terminal-status")?.textContent).toBe("Connecting…");
    connect();
    expect(host.container.querySelector(".terminal-status")).toBeNull();
    const ws = FakeWebSocket.instances[0];
    act(() => {
      ws?.drop();
    });
    expect(host.container.querySelector(".terminal-status")?.textContent).toBe("Reconnecting…");
  });

  it("reconnects with backoff and replays without reloading the page", () => {
    host = mount("s1");
    connect();
    act(() => {
      FakeWebSocket.instances[0]?.drop();
    });
    vi.advanceTimersByTime(1500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    connect(1);
    expect(FakeWebSocket.instances[1]?.lastFrame).toEqual({
      type: "terminal.attach",
      sessionId: "s1",
      cols: 80,
      rows: 24,
    });
    // The replay resets the pane again.
    const term = mountedTerminal();
    expect(term.resets).toBe(2);
  });

  it("propagates container resizes to tmux, debounced", () => {
    host = mount("s1");
    const term = mountedTerminal();
    connect();
    act(() => {
      term.cols = 120;
      term.rows = 35;
      FakeResizeObserver.instances.forEach((observer) => observer.callback());
    });
    expect(FakeWebSocket.instances[0]?.sent.some((raw) => raw.includes("terminal.resize"))).toBe(false);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(FakeWebSocket.instances[0]?.lastFrame).toEqual({
      type: "terminal.resize",
      sessionId: "s1",
      cols: 120,
      rows: 35,
    });
  });

  it("shows the jump-to-bottom pill while scrolled up and hides it at the bottom", () => {
    host = mount("s1");
    connect();
    const term = mountedTerminal();
    act(() => {
      term.buffer.active.viewportY = 10;
      term.fireScroll();
    });
    const pill = host.container.querySelector<HTMLButtonElement>(".terminal-jump");
    expect(pill).not.toBeNull();
    act(() => {
      pill?.click();
    });
    expect(term.scrolledToBottom).toBe(1);
    expect(host.container.querySelector(".terminal-jump")).toBeNull();
  });

  it("detaches the old session and attaches the new one when sessionId changes", () => {
    host = mount("s1");
    connect();
    act(() => {
      host?.root.render(<Terminal sessionId="s2" />);
    });
    // The first socket announced detach before closing.
    expect(FakeWebSocket.instances[0]?.sent.some((raw) => raw.includes("terminal.detach"))).toBe(true);
    const ws = connect(1);
    expect(ws.lastFrame).toEqual({ type: "terminal.attach", sessionId: "s2", cols: 80, rows: 24 });
    expect(FakeTerminal.instances).toHaveLength(2);
    expect(FakeTerminal.instances[0]?.disposed).toBe(true);
  });

  it("disposes the terminal and detaches on unmount", () => {
    host = mount("s1");
    connect();
    act(() => {
      host?.root.unmount();
    });
    host = null;
    expect(FakeTerminal.instances[0]?.disposed).toBe(true);
    expect(FakeWebSocket.instances[0]?.sent.some((raw) => raw.includes("terminal.detach"))).toBe(true);
  });
});

describe("<Terminal /> on touch devices", () => {
  beforeEach(() => {
    globalThis.matchMedia = ((query: string) => ({
      matches: query === "(pointer: coarse)",
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof matchMedia;
  });

  afterEach(() => {
    delete (globalThis as { matchMedia?: unknown }).matchMedia;
  });

  it("renders the key row and the composer, and locks xterm's textarea", () => {
    host = mount("s1");
    connect();
    const term = mountedTerminal();
    expect(host.container.querySelectorAll(".terminal-key")).toHaveLength(8);
    expect(host.container.querySelector(".terminal-composer")).not.toBeNull();
    expect(term.options.fontSize).toBe(12);
  });

  it("sends key-row sequences", () => {
    host = mount("s1");
    const ws = connect();
    const esc = [...host!.container.querySelectorAll<HTMLButtonElement>(".terminal-key")].find(
      (button) => button.textContent === "Esc",
    );
    act(() => {
      esc?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(ws.lastFrame).toEqual({ type: "terminal.data", sessionId: "s1", data: "\x1b" });
  });

  it("the composer sends on Enter and supports the sticky Ctrl modifier", () => {
    host = mount("s1");
    const ws = connect();
    const input = host!.container.querySelector<HTMLTextAreaElement>(".terminal-composer-input");
    expect(input).not.toBeNull();
    // Type a command and press Enter — the pane receives it with the Enter byte.
    // The native prototype setter bypasses React's value tracker, which would
    // otherwise swallow the change event (its cached value matches the DOM).
    const setValue = (value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(input!, value);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    };
    act(() => {
      input!.focus();
      setValue("make");
    });
    act(() => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(ws.lastFrame).toEqual({ type: "terminal.data", sessionId: "s1", data: "make\r" });
    expect(input!.value).toBe("");

    // Arm Ctrl, then press C: the control byte goes out, nothing is typed.
    const ctrl = [...host!.container.querySelectorAll<HTMLButtonElement>(".terminal-key")].find(
      (button) => button.textContent === "Ctrl",
    );
    act(() => {
      ctrl?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(ctrl?.getAttribute("aria-pressed")).toBe("true");
    const cKey = new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true });
    act(() => {
      input!.dispatchEvent(cKey);
    });
    expect(ws.lastFrame).toEqual({ type: "terminal.data", sessionId: "s1", data: "\x03" });
    expect(cKey.defaultPrevented).toBe(true);
    expect(ctrl?.getAttribute("aria-pressed")).toBe("false");
    expect(input!.value).toBe("");
  });

  it("Shift+Enter inserts a newline instead of sending", () => {
    host = mount("s1");
    const ws = connect();
    const input = host!.container.querySelector<HTMLTextAreaElement>(".terminal-composer-input");
    const setValue = (value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(input!, value);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    };
    act(() => {
      input!.focus();
      setValue("line one");
    });
    act(() => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(ws.sent).toHaveLength(1); // only the attach frame
    expect(input!.value).toBe("line one");
    act(() => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(ws.lastFrame).toEqual({ type: "terminal.data", sessionId: "s1", data: "line one\r" });
  });
});