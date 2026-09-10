/**
 * Terminal touch scrolling (issue #375): on touch devices swipes must reach
 * xterm's scrollback like desktop mouse-wheel scrolls do. The reported defect
 * — "scroll up doesn't work on mobile" — lived in xterm 5.5's built-in touch
 * path: its first touchmove preventDefault let the browser's native pan claim
 * the gesture, the compositor cancelled the stream, and every swipe stopped
 * after about one line. The fix takes the gesture over at the JS level (the
 * takeover upstream shipped in xterm 6.0, commit 38913e4a): claim from
 * touchstart, preventDefault so the browser never pans, scroll the hidden
 * viewport box from touch deltas. These tests pin that contract with
 * structural stubs (no live xterm needed).
 */

import { describe, expect, it, vi } from "vitest";
import { createTouchScrollController, type TouchScrollSurface } from "./touch-scroll";

/** A touch-like event: one finger, cancelable, preventDefault-observable. */
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
    addEventListener: vi.fn((type: string, fn: EventListener, _options?: AddEventListenerOptions) => {
      listeners.set(type, { fn, options: _options });
    }),
    removeEventListener: vi.fn((type: string, fn: EventListener, _options?: AddEventListenerOptions) => {
      const current = listeners.get(type);
      if (current?.fn === fn) listeners.delete(type);
    }),
  };
  const dispatch = (event: Event) => {
    const listener = listeners.get(event.type);
    listener?.fn(event);
  };
  const surface: TouchScrollSurface = {
    element: element as unknown as TouchScrollSurface["element"],
    viewport: { scrollTop: 0 } as HTMLElement,
    textarea,
  };
  return { element, listeners, dispatch, surface };
}

describe("touch-scroll controller: scroll delivery (issue #375)", () => {
  it("registers non-passive touch listeners", () => {
    const { element, listeners, surface } = stubSurface();
    createTouchScrollController(surface);
    expect(element.addEventListener).toHaveBeenCalledTimes(4);
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      expect(listeners.get(type)?.options?.passive).toBe(false);
    }
  });

  it("claims the gesture on touchstart — the browser never pans", () => {
    const { dispatch, surface } = stubSurface();
    createTouchScrollController(surface);
    const start = touchEvent("touchstart", [{ identifier: 1, pageY: 300 }]);
    dispatch(start);
    // The claim is the fix: the native pan was what swallowed every swipe.
    expect(start.preventDefault).toHaveBeenCalled();
  });

  it("scrolls the viewport by the finger's delta — swipe down reaches scrollback", () => {
    const { dispatch, surface } = stubSurface();
    createTouchScrollController(surface);
    dispatch(touchEvent("touchstart", [{ identifier: 1, pageY: 300 }], { timeStamp: 1000 }));
    // Finger moves down 60px across two moves (pageY grows) — the same
    // gesture a desktop user makes with mouse-wheel up: older lines.
    dispatch(touchEvent("touchmove", [{ identifier: 1, pageY: 330 }], { timeStamp: 1030 }));
    dispatch(touchEvent("touchmove", [{ identifier: 1, pageY: 360 }], { timeStamp: 1060 }));
    expect(surface.viewport.scrollTop).toBe(-60);
  });

  it("returns to live by swiping up — the two directions mirror", () => {
    const { dispatch, surface } = stubSurface();
    surface.viewport.scrollTop = 500;
    createTouchScrollController(surface);
    dispatch(touchEvent("touchstart", [{ identifier: 1, pageY: 360 }], { timeStamp: 1000 }));
    dispatch(touchEvent("touchmove", [{ identifier: 1, pageY: 300 }], { timeStamp: 1060 }));
    expect(surface.viewport.scrollTop).toBe(560);
  });

  it("keeps scrolling through a whole gesture — the stream is never cut", () => {
    // The defect: exactly one line per swipe. A full-length gesture must
    // deliver every move (an uninterrupted 300px drag scrolls 300px).
    const { dispatch, surface } = stubSurface();
    createTouchScrollController(surface);
    dispatch(touchEvent("touchstart", [{ identifier: 1, pageY: 560 }], { timeStamp: 0 }));
    let pageY = 560;
    for (let i = 0; i < 10; i++) {
      pageY -= 30;
      dispatch(touchEvent("touchmove", [{ identifier: 1, pageY }], { timeStamp: 16 * (i + 1) }));
    }
    expect(surface.viewport.scrollTop).toBe(300);
  });

  it("scrolls by each finger's own delta", () => {
    const { dispatch, surface } = stubSurface();
    createTouchScrollController(surface);
    dispatch(
      touchEvent("touchstart", [
        { identifier: 1, pageY: 300 },
        { identifier: 2, pageY: 400 },
      ], { timeStamp: 1000 }),
    );
    dispatch(touchEvent("touchmove", [
      { identifier: 1, pageY: 320 },
      { identifier: 2, pageY: 390 },
    ], { timeStamp: 1030 }));
    // Finger 1 moved +20 (scroll up 20), finger 2 moved −10 (scroll down 10).
    expect(surface.viewport.scrollTop).toBe(-10);
  });

});

describe("touch-scroll controller: tap focus + teardown (issue #375)", () => {
  it("focuses the textarea once on a tap — parity with desktop mousedown", () => {
    // Claimed touchstarts suppress the browser's synthesized mousedown, the
    // chain xterm focuses through on desktop; the controller replays it.
    const textarea = { focus: vi.fn() } as unknown as HTMLElement;
    const { dispatch, surface } = stubSurface(textarea);
    createTouchScrollController(surface);
    dispatch(touchEvent("touchstart", [{ identifier: 1, pageY: 300 }], { timeStamp: 1000 }));
    dispatch(touchEvent("touchend", [{ identifier: 1, pageY: 300 }], { timeStamp: 1150, changed: true }));
    expect(textarea.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("does not focus after a swipe — a scroll gesture is not a tap", () => {
    const textarea = { focus: vi.fn() } as unknown as HTMLElement;
    const { dispatch, surface } = stubSurface(textarea);
    createTouchScrollController(surface);
    dispatch(touchEvent("touchstart", [{ identifier: 1, pageY: 560 }], { timeStamp: 1000 }));
    dispatch(touchEvent("touchmove", [{ identifier: 1, pageY: 400 }], { timeStamp: 1030 }));
    dispatch(touchEvent("touchend", [{ identifier: 1, pageY: 400 }], { timeStamp: 1150, changed: true }));
    expect(textarea.focus).not.toHaveBeenCalled();
  });

  it("does not focus a long, still touch (hold) or after drift accumulates", () => {
    const textarea = { focus: vi.fn() } as unknown as HTMLElement;
    const { dispatch, surface } = stubSurface(textarea);
    createTouchScrollController(surface);
    // 700ms hold, no movement — a long-press, not a tap.
    dispatch(touchEvent("touchstart", [{ identifier: 1, pageY: 300 }], { timeStamp: 1000 }));
    dispatch(touchEvent("touchend", [{ identifier: 1, pageY: 300 }], { timeStamp: 1700, changed: true }));
    expect(textarea.focus).not.toHaveBeenCalled();
    // Or many sub-drift moves that sum past the tap threshold.
    dispatch(touchEvent("touchstart", [{ identifier: 1, pageY: 300 }], { timeStamp: 2000 }));
    for (let i = 0; i < 10; i++) {
      dispatch(touchEvent("touchmove", [{ identifier: 1, pageY: 298 - i * 2 }], { timeStamp: 2000 + i }));
    }
    dispatch(touchEvent("touchend", [{ identifier: 1, pageY: 280 }], { timeStamp: 2100, changed: true }));
    expect(textarea.focus).not.toHaveBeenCalled();
  });

  it("tolerates touch-like events that carry no finger lists", () => {
    // Some engines emit compat touch events whose shape varies mid-gesture;
    // the takeover must never throw and never scroll on them.
    const { dispatch, surface } = stubSurface();
    createTouchScrollController(surface);
    expect(() => {
      dispatch({ type: "touchmove", timeStamp: 1, cancelable: true, preventDefault: vi.fn() } as unknown as Event);
      dispatch({ type: "touchend", timeStamp: 2, cancelable: true, preventDefault: vi.fn() } as unknown as Event);
    }).not.toThrow();
    expect(surface.viewport.scrollTop).toBe(0);
  });

  it("ignores a swipe whose finger was never seen at touchstart", () => {
    // A finger seen only in a move (e.g. a second finger landing mid-gesture
    // under a stalled start) has no baseline and must not scroll.
    const { dispatch, surface } = stubSurface();
    createTouchScrollController(surface);
    dispatch(touchEvent("touchstart", [], { timeStamp: 1000 }));
    dispatch(touchEvent("touchmove", [{ identifier: 1, pageY: 300 }], { timeStamp: 1030 }));
    expect(surface.viewport.scrollTop).toBe(0);
  });

  it("disposes every listener and forgets held fingers", () => {
    const { element, listeners, dispatch, surface } = stubSurface();
    const controller = createTouchScrollController(surface);
    dispatch(touchEvent("touchstart", [{ identifier: 1, pageY: 300 }], { timeStamp: 1000 }));
    controller.dispose();
    expect(listeners.size).toBe(0);
    expect(element.removeEventListener).toHaveBeenCalledTimes(4);
    // A second gesture after dispose does nothing at all.
    dispatch(touchEvent("touchstart", [{ identifier: 1, pageY: 300 }], { timeStamp: 2000 }));
    dispatch(touchEvent("touchmove", [{ identifier: 1, pageY: 400 }], { timeStamp: 2030 }));
    expect(surface.viewport.scrollTop).toBe(0);
  });
});
