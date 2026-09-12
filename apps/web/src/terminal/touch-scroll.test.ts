/**
 * Tests for the terminal touch-scroll takeover: swipes scroll xterm's
 * scrollback like desktop mouse-wheel scrolls do. Pinned with structural
 * stubs (no live xterm needed).
 */

import { describe, expect, it, vi } from "vitest";
import { createTouchScrollController, type TouchScrollSurface } from "./touch-scroll";

/** A touch-like event: fingers, cancelable, preventDefault-observable. */
function touchEvent(
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  fingers: Array<{ identifier: number; pageY: number }>,
  { changed = false, timeStamp = 0, cancelable = true } = {},
): Event & { preventDefault: ReturnType<typeof vi.fn>; timeStamp: number } {
  const list = fingers.map((f) => ({ ...f }));
  return {
    type,
    timeStamp,
    cancelable,
    preventDefault: vi.fn(),
    ...(changed ? { changedTouches: list } : { touches: list }),
  } as never;
}

/** Installs the controller against stub elements and records every listener. */
function stubSurface(textarea: HTMLElement | null = null) {
  const listeners = new Map<string, { fn: EventListener; options?: AddEventListenerOptions }>();
  const element = {
    addEventListener: vi.fn((type: string, fn: EventListener, options?: AddEventListenerOptions) => {
      listeners.set(type, { fn, options });
    }),
    removeEventListener: vi.fn((type: string, fn: EventListener, options?: AddEventListenerOptions) => {
      const current = listeners.get(type);
      if (current?.fn === fn && current.options === options) listeners.delete(type);
    }),
  };
  const dispatch = (event: Event) => {
    listeners.get(event.type)?.fn(event);
  };
  const surface: TouchScrollSurface = {
    element: element as unknown as TouchScrollSurface["element"],
    viewport: { scrollTop: 0 } as HTMLElement,
    textarea,
  };
  return { element, dispatch, surface };
}

describe("touch-scroll controller", () => {
  it("registers non-passive touch listeners", () => {
    const { element, surface } = stubSurface();
    createTouchScrollController(surface);
    expect(element.addEventListener).toHaveBeenCalledTimes(4);
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      expect(element.addEventListener.mock.calls.find((call) => call[0] === type)?.[2]?.passive).toBe(false);
    }
  });

  it("claims the gesture on touchstart — the browser never pans", () => {
    const { dispatch, surface } = stubSurface();
    createTouchScrollController(surface);
    const start = touchEvent("touchstart", [{ identifier: 1, pageY: 300 }]);
    dispatch(start);
    expect(start.preventDefault).toHaveBeenCalled();
  });

  it("scrolls the viewport by the finger's delta — swipe down reaches scrollback", () => {
    const { dispatch, surface } = stubSurface();
    createTouchScrollController(surface);
    dispatch(touchEvent("touchstart", [{ identifier: 1, pageY: 300 }], { timeStamp: 1000 }));
    dispatch(touchEvent("touchmove", [{ identifier: 1, pageY: 340 }]));
    dispatch(touchEvent("touchmove", [{ identifier: 1, pageY: 360 }]));
    expect(surface.viewport.scrollTop).toBe(-60);
  });

  it("swipe up returns to the bottom (positive scrollTop)", () => {
    const { dispatch, surface } = stubSurface();
    createTouchScrollController(surface);
    dispatch(touchEvent("touchstart", [{ identifier: 1, pageY: 300 }], { timeStamp: 1000 }));
    dispatch(touchEvent("touchmove", [{ identifier: 1, pageY: 240 }]));
    expect(surface.viewport.scrollTop).toBe(60);
  });

  it("tracks multiple fingers independently", () => {
    const { dispatch, surface } = stubSurface();
    createTouchScrollController(surface);
    dispatch(
      touchEvent("touchstart", [
        { identifier: 1, pageY: 300 },
        { identifier: 2, pageY: 500 },
      ]),
    );
    dispatch(
      touchEvent("touchmove", [
        { identifier: 1, pageY: 260 },
        { identifier: 2, pageY: 330 },
      ]),
    );
    expect(surface.viewport.scrollTop).toBe(210); // +40 (finger 1) + 170 (finger 2)
  });

  it("replays a tap as textarea focus (tap parity with desktop)", () => {
    const textarea = { focus: vi.fn() } as unknown as HTMLElement;
    const { dispatch, surface } = stubSurface(textarea);
    createTouchScrollController(surface);
    dispatch(touchEvent("touchstart", [{ identifier: 1, pageY: 300 }], { timeStamp: 1000 }));
    dispatch(touchEvent("touchend", [{ identifier: 1, pageY: 305 }], { changed: true, timeStamp: 1200 }));
    expect(textarea.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("a swipe is not a tap — no focus", () => {
    const textarea = { focus: vi.fn() } as unknown as HTMLElement;
    const { dispatch, surface } = stubSurface(textarea);
    createTouchScrollController(surface);
    dispatch(touchEvent("touchstart", [{ identifier: 1, pageY: 300 }], { timeStamp: 1000 }));
    dispatch(touchEvent("touchmove", [{ identifier: 1, pageY: 400 }]));
    dispatch(touchEvent("touchend", [{ identifier: 1, pageY: 400 }], { changed: true, timeStamp: 1200 }));
    expect(textarea.focus).not.toHaveBeenCalled();
  });

  it("dispose removes every listener", () => {
    const { element, surface } = stubSurface();
    const controller = createTouchScrollController(surface);
    expect(element.addEventListener).toHaveBeenCalledTimes(4);
    controller.dispose();
    expect(element.removeEventListener).toHaveBeenCalledTimes(4);
  });
});