/**
 * Terminal touch scrolling: on touch devices swipes must reach xterm's
 * scrollback like desktop mouse-wheel scrolls do.
 *
 * Root cause of "scroll doesn't work on mobile": xterm 5.5's built-in touch
 * path scrolls by writing the hidden overflow box's scrollTop, then still asks
 * the browser to pan via the event default — the claimed gesture dies at the
 * compositor and the stream is cancelled after the first move, so a swipe
 * moves about one line and stops. Upstream fixed exactly this class of break
 * in xterm 6.0 by taking the gesture over at the JS level: claim it from
 * touchstart, preventDefault so the browser never pans, and scroll the
 * viewport from touch deltas. This controller is that takeover, scoped to the
 * app (xterm 5.5 cannot be upgraded here).
 *
 * Composes with the mobile input gate: the textarea focus on tap is
 * parity-only (the OS keyboard stays locked out of the gated textarea), and
 * the coarse-pointer flag that installs this controller is the same flag that
 * gates the composer. Mechanisms are distinct — this touches only the
 * viewport's scroll path, never the input path.
 */

/**
 * Structural slice of the DOM the controller needs — kept minimal so tests
 * can pass stubs instead of a live xterm surface.
 */
export interface TouchScrollSurface {
  /** The xterm root element (`.terminal.xterm`) — the swipe hit target. */
  element: EventTarget & {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions): void;
  };
  /** The hidden overflow box (`.xterm-viewport`) whose scrollTop scrolls. */
  viewport: HTMLElement;
  /** The hidden textarea, focused on tap (tap parity with desktop focus). */
  textarea: HTMLElement | null;
}

/** Disposable handle for teardown (never leaks a listener into a dead pane). */
export interface TouchScrollController {
  dispose(): void;
}

/** Small movement + short duration = a tap, not a swipe. */
const TAP_MAX_MS = 500;
const TAP_MAX_DRIFT = 10;

/** Per-finger swipe state (multi-finger swipes scroll by each finger's own delta). */
interface Swipe {
  lastY: number;
  startY: number;
  startT: number;
  drift: number;
}

/**
 * Installs the touch-scroll takeover on one terminal surface. Only reacts to
 * touch events — mouse wheel, mouse selection, and the key row are untouched
 * paths — and returns the disposer for the pane's teardown.
 */
export function createTouchScrollController(surface: TouchScrollSurface): TouchScrollController {
  const { element, viewport, textarea } = surface;
  // Fingers currently down, keyed by touch identifier.
  const swipes = new Map<number, Swipe>();

  const onTouchStart = (event: Event) => {
    // Claim the gesture: the browser must not pan/zoom under the finger —
    // that native scroll is what swallowed every swipe after the first move.
    event.preventDefault();
    const startT = event.timeStamp;
    for (const touch of touchesOf(event)) {
      swipes.set(touch.identifier, {
        lastY: touch.pageY,
        startY: touch.pageY,
        startT,
        drift: 0,
      });
    }
  };

  const onTouchMove = (event: Event) => {
    // Held only if the browser still thought it owned the gesture (e.g. a
    // swipe that began before the controller attached). Never throws for
    // uncancelable ghost events.
    event.preventDefault();
    for (const touch of touchesOf(event)) {
      const swipe = swipes.get(touch.identifier);
      if (!swipe) continue;
      // Finger down (pageY grows) = scroll up into scrollback: scrollTop
      // decreases, the same direction desktop wheel-up scrolls.
      const dy = swipe.lastY - touch.pageY;
      swipe.lastY = touch.pageY;
      swipe.drift += Math.abs(dy);
      if (dy !== 0) viewport.scrollTop += dy;
    }
  };

  const onTouchEnd = (event: Event) => {
    for (const touch of touchesOf(event, { changed: true })) {
      const swipe = swipes.get(touch.identifier);
      if (!swipe) continue;
      swipes.delete(touch.identifier);
      // Tap parity: on desktop the browser synthesizes mousedown from a tap
      // and xterm's own handler focuses the textarea ({preventScroll:true}).
      // Claimed touchstarts suppress that synthesis, so the tap is replayed.
      if (
        swipe.drift < TAP_MAX_DRIFT &&
        event.timeStamp - swipe.startT < TAP_MAX_MS &&
        textarea !== null
      ) {
        textarea.focus({ preventScroll: true });
      }
    }
  };

  const onTouchCancel = (event: Event) => {
    for (const touch of touchesOf(event, { changed: true })) {
      swipes.delete(touch.identifier);
    }
  };

  element.addEventListener("touchstart", onTouchStart, { passive: false });
  element.addEventListener("touchmove", onTouchMove, { passive: false });
  element.addEventListener("touchend", onTouchEnd, { passive: false });
  element.addEventListener("touchcancel", onTouchCancel, { passive: false });

  return {
    dispose() {
      element.removeEventListener("touchstart", onTouchStart, { passive: false });
      element.removeEventListener("touchmove", onTouchMove, { passive: false });
      element.removeEventListener("touchend", onTouchEnd, { passive: false });
      element.removeEventListener("touchcancel", onTouchCancel, { passive: false });
      swipes.clear();
    },
  };
}

/**
 * Touches carried by a touch event. Iterates `changedTouches` for end/cancel
 * (the fingers the event is about) and `touches` otherwise, and tolerates
 * touch-like events with no lists at all — those contribute no fingers.
 */
function touchesOf(
  event: Event & { touches?: ArrayLike<{ identifier: number; pageY: number }>; changedTouches?: ArrayLike<{ identifier: number; pageY: number }> },
  { changed = false }: { changed?: boolean } = {},
): Array<{ identifier: number; pageY: number }> {
  const list = changed ? event.changedTouches : event.touches;
  return list ? Array.from(list) : [];
}