/**
 * Terminal tap-to-open links on touch devices (deep-design pass, flag (a)):
 * the #375 touch-scroll takeover claims every gesture on the terminal
 * surface with `preventDefault()` on touchstart, which suppresses the
 * browser's tap→click synthesis — and xterm 5.5's linkifier is mouse-only
 * (mousemove hovers the link, mousedown+mouseup activate it; it never sees
 * touch events). Result: OSC-8/web links printed in the pane stopped
 * opening on phones after the takeover landed.
 *
 * Fix: replay tap-qualified touches as a synthetic mouse triple
 * (mousemove → mousedown → mouseup) at the touch point. xterm's linkifier
 * processes that synchronously (`getCoords` maps clientX/clientY through the
 * element's bounding rect), so a tap on a link activates it exactly like a
 * desktop click — including hover state — while a swipe never replays
 * anything and the scroll takeover stays the sole owner of the pan gesture.
 * This controller never calls preventDefault, so the scroll path (#375) is
 * untouched; taps on non-link cells replay as an ordinary click (selection
 * cleared, textarea focused) — the same thing a desktop click does.
 *
 * Gated by the same coarse-pointer flag as the takeover and the composer
 * (mobile-input.tsx): fine-pointer devices keep xterm's stock touch path.
 */

/** What the controller needs from the pane — the xterm root element only. */
export interface LinkTapSurface {
  element: EventTarget & {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions): void;
  };
}

/** Disposable handle (same teardown convention as the other controllers). */
export interface LinkTapController {
  dispose(): void;
}

/** A tap starts and ends within 500ms… */
const TAP_MAX_MS = 500;
/** …and the finger drifts less than 10px — anything more is a swipe. */
const TAP_MAX_DRIFT = 10;

/** One pending tap candidate (single-finger only; multi-touch never replays). */
interface PendingTap {
  x: number;
  y: number;
  startedAt: number;
}

/**
 * Installs the tap→link replay on the terminal surface. Returns the
 * disposer for the pane's teardown. Purely additive: no event is ever
 * cancelled, so the #375 scroll takeover keeps owning every gesture.
 */
export function createLinkTapController(surface: LinkTapSurface): LinkTapController {
  const { element } = surface;
  let pending: PendingTap | null = null;

  const onTouchStart = (event: TouchEvent) => {
    // Only a lone finger can be a tap; a second finger down is a pinch or a
    // two-finger gesture, never a link tap.
    if (event.touches.length !== 1) {
      pending = null;
      return;
    }
    const touch = event.touches[0];
    if (touch === undefined) {
      pending = null;
      return;
    }
    pending = { x: touch.clientX, y: touch.clientY, startedAt: event.timeStamp };
  };

  const onTouchMove = (event: TouchEvent) => {
    if (pending === null) return;
    const touch = event.touches[0];
    if (touch === undefined) return;
    // Swiped far enough — this is a scroll, not a tap; stop watching.
    if (Math.abs(touch.clientX - pending.x) >= TAP_MAX_DRIFT || Math.abs(touch.clientY - pending.y) >= TAP_MAX_DRIFT) {
      pending = null;
    }
  };

  const onTouchEnd = (event: TouchEvent) => {
    const start = pending;
    pending = null;
    if (start === null || event.timeStamp - start.startedAt > TAP_MAX_MS) return;
    const touch = event.changedTouches[0];
    if (touch === undefined) return;
    replayAsMouse(start.x, start.y, touch.clientX, touch.clientY);
  };

  const onTouchCancel = () => {
    pending = null;
  };

  element.addEventListener("touchstart", onTouchStart as EventListener);
  element.addEventListener("touchmove", onTouchMove as EventListener);
  element.addEventListener("touchend", onTouchEnd as EventListener);
  element.addEventListener("touchcancel", onTouchCancel as EventListener);

  return {
    dispose() {
      element.removeEventListener("touchstart", onTouchStart as EventListener);
      element.removeEventListener("touchmove", onTouchMove as EventListener);
      element.removeEventListener("touchend", onTouchEnd as EventListener);
      element.removeEventListener("touchcancel", onTouchCancel as EventListener);
      pending = null;
    },
  };
}

/**
 * Replays one tap as the mouse sequence xterm's linkifier expects: hover
 * first (mousemove registers the link under the pointer), then the
 * mousedown→mouseup pair whose up half activates it
 * (`Linkifier._handleMouseUp` → `link.activate`). Coordinates come from the
 * finger's final position — the browser lays the synthesized click where
 * the finger lifted, not where it landed.
 */
function replayAsMouse(downX: number, downY: number, upX: number, upY: number): void {
  const target = document.elementFromPoint(upX, upY) ?? undefined;
  if (target === undefined) return;
  const init = (buttons: number): MouseEventInit => ({
    bubbles: true,
    cancelable: true,
    clientX: upX,
    clientY: upY,
    screenX: upX,
    screenY: upY,
    button: 0,
    buttons,
  });
  target.dispatchEvent(new MouseEvent("mousemove", init(0)));
  target.dispatchEvent(new MouseEvent("mousedown", { ...init(1), detail: 1 }));
  target.dispatchEvent(new MouseEvent("mouseup", { ...init(0), detail: 1 }));
}
