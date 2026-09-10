/**
 * Tap-to-open terminal links on touch devices (deep-design pass, flag (a)):
 * the #375 touch-scroll takeover claims every gesture on the terminal
 * surface with `preventDefault()` on touchstart, which suppresses the
 * browser's tap→click synthesis — and xterm 5.5's linkifier is mouse-only
 * (mousemove hovers the link, mousedown+mouseup activate it; it never sees
 * touch events). Result: OSC-8/web links printed in the pane stopped
 * opening on phones after the takeover landed.
 *
 * The controller here replays tap-qualified touches as the mouse triple
 * xterm's linkifier activates on. These tests run in the node environment
 * (like touch-scroll.test.ts) with stubs for `document` and `MouseEvent` —
 * the module only needs `document.elementFromPoint` and the constructor.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinkTapController, type LinkTapSurface } from "./terminal-link-taps";

/** Minimal replay-target record: what mouse events it received. */
class TargetStub {
  readonly dispatched: Array<{ type: string; x: number; y: number }> = [];
  dispatchEvent(event: { type: string; clientX: number; clientY: number }): boolean {
    this.dispatched.push({ type: event.type, x: event.clientX, y: event.clientY });
    return true;
  }
}

/** Minimal MouseEvent double: carries type + coordinates, nothing else. */
class FakeMouseEvent {
  readonly type: string;
  readonly clientX: number;
  readonly clientY: number;
  constructor(type: string, init: { clientX?: number; clientY?: number } = {}) {
    this.type = type;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
  }
}

/** Records listeners (the stub shape follows touch-scroll.test.ts's convention). */
class SurfaceStub {
  readonly listeners = new Map<string, EventListener>();

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }
}

/** A minimal TouchEvent-ish object: touches / changedTouches / timeStamp. */
function touchEvent(
  type: string,
  touches: Array<{ clientX: number; clientY: number }>,
  changed: Array<{ clientX: number; clientY: number }> = [],
  timeStamp = 0,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: touches.map((touch, i) => ({ identifier: i, ...touch })) },
    changedTouches: { value: changed.map((touch, i) => ({ identifier: i, ...touch })) },
    timeStamp: { value: timeStamp },
  });
  return event;
}

/** Stubs `document` + `MouseEvent` for the replay path; returns the target. */
function stubReplay(): TargetStub {
  const target = new TargetStub();
  vi.stubGlobal("MouseEvent", FakeMouseEvent);
  vi.stubGlobal("document", { elementFromPoint: () => target });
  return target;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("link tap replay (tap-qualified touch → mouse triple)", () => {
  it("replays a quick, still touch as mousemove → mousedown → mouseup at the lift point", () => {
    const surface = new SurfaceStub();
    const target = stubReplay();
    const controller = createLinkTapController({ element: surface as unknown as LinkTapSurface["element"] });
    surface.listeners.get("touchstart")!(
      touchEvent("touchstart", [{ clientX: 50, clientY: 60 }], [], 1000) as TouchEvent,
    );
    surface.listeners.get("touchend")!(
      touchEvent("touchend", [], [{ clientX: 50, clientY: 58 }], 1300) as TouchEvent,
    );
    expect(target.dispatched.map((event) => event.type)).toEqual(["mousemove", "mousedown", "mouseup"]);
    // Coordinates come from the finger's lift point, not the landing point.
    for (const event of target.dispatched) {
      expect(event.x).toBe(50);
      expect(event.y).toBe(58);
    }
    controller.dispose();
  });

  it("never replays a swipe (drift ≥ 10px) — the scroll takeover owns gestures", () => {
    const surface = new SurfaceStub();
    const target = stubReplay();
    const controller = createLinkTapController({ element: surface as unknown as LinkTapSurface["element"] });
    surface.listeners.get("touchstart")!(
      touchEvent("touchstart", [{ clientX: 50, clientY: 60 }], [], 1000) as TouchEvent,
    );
    surface.listeners.get("touchmove")!(
      touchEvent("touchmove", [{ clientX: 50, clientY: 80 }], [], 1050) as TouchEvent,
    );
    surface.listeners.get("touchend")!(
      touchEvent("touchend", [], [{ clientX: 50, clientY: 90 }], 1100) as TouchEvent,
    );
    expect(target.dispatched).toEqual([]);
    controller.dispose();
  });

  it("never replays a long press (> 500ms)", () => {
    const surface = new SurfaceStub();
    const target = stubReplay();
    const controller = createLinkTapController({ element: surface as unknown as LinkTapSurface["element"] });
    surface.listeners.get("touchstart")!(
      touchEvent("touchstart", [{ clientX: 50, clientY: 60 }], [], 1000) as TouchEvent,
    );
    surface.listeners.get("touchend")!(
      touchEvent("touchend", [], [{ clientX: 50, clientY: 60 }], 1700) as TouchEvent,
    );
    expect(target.dispatched).toEqual([]);
    controller.dispose();
  });

  it("ignores multi-finger gestures (a second finger kills the pending tap)", () => {
    const surface = new SurfaceStub();
    const target = stubReplay();
    const controller = createLinkTapController({ element: surface as unknown as LinkTapSurface["element"] });
    surface.listeners.get("touchstart")!(
      touchEvent("touchstart", [{ clientX: 50, clientY: 60 }], [], 1000) as TouchEvent,
    );
    surface.listeners.get("touchstart")!(
      touchEvent(
        "touchstart",
        [
          { clientX: 50, clientY: 60 },
          { clientX: 90, clientY: 60 },
        ],
        [],
        1050,
      ) as TouchEvent,
    );
    surface.listeners.get("touchend")!(
      touchEvent("touchend", [], [{ clientX: 50, clientY: 60 }], 1100) as TouchEvent,
    );
    expect(target.dispatched).toEqual([]);
    controller.dispose();
  });

});

describe("link tap replay edge cases", () => {
  it("replays nothing when the lift point has no element (off-window)", () => {
    const surface = new SurfaceStub();
    const target = new TargetStub();
    vi.stubGlobal("MouseEvent", FakeMouseEvent);
    vi.stubGlobal("document", { elementFromPoint: () => null });
    const controller = createLinkTapController({ element: surface as unknown as LinkTapSurface["element"] });
    surface.listeners.get("touchstart")!(
      touchEvent("touchstart", [{ clientX: 50, clientY: 60 }], [], 1000) as TouchEvent,
    );
    surface.listeners.get("touchend")!(
      touchEvent("touchend", [], [{ clientX: 50, clientY: 60 }], 1100) as TouchEvent,
    );
    expect(target.dispatched).toEqual([]);
    controller.dispose();
  });

  it("drops the pending tap on touchcancel", () => {
    const surface = new SurfaceStub();
    const target = stubReplay();
    const controller = createLinkTapController({ element: surface as unknown as LinkTapSurface["element"] });
    surface.listeners.get("touchstart")!(
      touchEvent("touchstart", [{ clientX: 50, clientY: 60 }], [], 1000) as TouchEvent,
    );
    surface.listeners.get("touchcancel")!(new Event("touchcancel") as TouchEvent);
    surface.listeners.get("touchend")!(
      touchEvent("touchend", [], [{ clientX: 50, clientY: 60 }], 1100) as TouchEvent,
    );
    expect(target.dispatched).toEqual([]);
    controller.dispose();
  });
});

describe("link tap replay stays a good citizen of the touch surface", () => {
  it("never cancels a touch event — the scroll takeover keeps owning every gesture", () => {
    const surface = new SurfaceStub();
    stubReplay();
    const controller = createLinkTapController({ element: surface as unknown as LinkTapSurface["element"] });
    const start = touchEvent("touchstart", [{ clientX: 50, clientY: 60 }], [], 1000) as TouchEvent;
    surface.listeners.get("touchstart")!(start);
    expect(start.defaultPrevented).toBe(false);
    const end = touchEvent("touchend", [], [{ clientX: 50, clientY: 60 }], 1100) as TouchEvent;
    surface.listeners.get("touchend")!(end);
    expect(end.defaultPrevented).toBe(false);
    controller.dispose();
  });

  it("dispose removes every listener", () => {
    const surface = new SurfaceStub();
    stubReplay();
    const controller = createLinkTapController({ element: surface as unknown as LinkTapSurface["element"] });
    controller.dispose();
    expect(surface.listeners.size).toBe(0);
  });
});
