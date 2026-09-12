/**
 * The browser terminal for one session: xterm.js bound to the daemon's
 * WebSocket terminal protocol (see ./connection.ts). The pane fills its
 * container; container resizes are debounced and propagated to tmux via
 * `terminal.resize`. The connection reconnects with backoff and the daemon
 * replays the session's ring buffer, so the pane rebuilds its scrollback —
 * while disconnected, a small pill in the corner says so.
 *
 * xterm owns scrollback locally: scrolling is native for mouse, trackpad, and
 * touch (touch-scroll.ts), and a jump-to-bottom pill appears while the user
 * is reading history — new output never yanks the view (xterm keeps the
 * viewport anchored while scrolled up; the pill just makes the way back
 * visible).
 *
 * Mobile: on coarse-pointer devices the OS keyboard never types into xterm's
 * hidden textarea (see mobile-input.tsx) — composed text enters through the
 * composer field, with a key row for the keys a touch keyboard lacks.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { InputBatcher } from "./input-batcher";
import { controlSeq, TERMINAL_KEYS } from "./keys";
import {
  MOBILE_POINTER_QUERY,
  MobileComposer,
  useCoarsePointer,
  useMobileTextareaGate,
} from "./mobile-input";
import { TerminalConnection, type TerminalStatus } from "./connection";
import { createFitController } from "./terminal-fit";
import { TERMINAL_THEME } from "./terminal-theme";
import { createTouchScrollController } from "./touch-scroll";
import "./terminal.css";

const STATUS_LABELS: Record<TerminalStatus, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
};

/**
 * Whether the disconnected pill should show: only while the pane is not
 * streaming — connecting or mid-backoff. Attached panes stay quiet.
 */
function disconnected(status: TerminalStatus): boolean {
  return status !== "connected";
}

/** The mono font from the app's `--font-mono` token, with a safe fallback. */
export function monoFontFamily(): string {
  const token = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return token || '"JetBrainsMono Nerd Font", "FiraCode Nerd Font", ui-monospace, Menlo, monospace';
}

/**
 * Renderer selection: prefer the WebGL renderer, fall back to 2D canvas, and
 * keep xterm's DOM renderer as the last resort. Both canvas-based renderers
 * rasterize box-drawing glyphs themselves onto a fixed cell grid; the DOM
 * renderer does not, so TUI borders drift and background runs snap sub-pixel
 * on fractional device pixel ratios (trailing spaces and background colours
 * must render exactly). WebGL contexts can be lost (hidden tabs, GPU resets)
 * — `onContextLoss` swaps in the canvas renderer so the pane keeps rendering
 * for the rest of its life. Loaded after the terminal opens.
 */
export function loadRenderer(term: XTerm): void {
  let canvasLoaded = false;
  const loadCanvas = () => {
    if (canvasLoaded) return;
    canvasLoaded = true;
    try {
      term.loadAddon(new CanvasAddon());
    } catch {
      // No canvas either — the DOM renderer keeps the pane usable.
    }
  };
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      loadCanvas();
    });
    term.loadAddon(webgl);
  } catch {
    loadCanvas();
  }
}

/**
 * Mount/teardown of one terminal instance: builds the xterm surface, wires
 * output, keystroke batching, fit, touch scrolling, and the session attach,
 * and undoes all of it on unmount or session change. The callbacks live in
 * stable refs so the effect stays dependency-free — the terminal is never
 * torn down because a handler identity changed.
 */
function useTerminalMount(
  sessionId: string,
  containerRef: RefObject<HTMLDivElement | null>,
  sendRef: RefObject<((data: string) => void) | null>,
  termRef: RefObject<XTerm | null>,
  onStatus: (status: TerminalStatus) => void,
  onJump: (scrolledUp: boolean) => void,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const coarse =
      typeof globalThis.matchMedia === "function" && globalThis.matchMedia(MOBILE_POINTER_QUERY).matches;
    const term = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
      scrollback: 5000,
      fontSize: coarse ? 12 : 13,
      lineHeight: 1.35,
      fontFamily: monoFontFamily(),
      theme: TERMINAL_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";
    term.open(container);
    loadRenderer(term);
    termRef.current = term;

    // Set once the fit controller exists; the connection's onReplay fires
    // on every fresh socket — exactly the reattach moments that need the
    // pane re-fitted to its settled layout before the replay renders.
    let refitOnFrame: () => void = () => {};
    const connection = new TerminalConnection({
      onData: (data) => term.write(data),
      onReplay: () => {
        term.reset();
        refitOnFrame();
      },
      onStatus,
    });
    // Coalesce keystroke bursts into fewer, larger WS frames.
    const batcher = new InputBatcher((data) => connection.sendInput(data));
    term.onData((data) => batcher.add(data));
    sendRef.current = (data) => batcher.add(data);

    const fitNow = createFitController({ terminal: term, fit: () => fit.fit(), connection });
    const observer = new ResizeObserver(() => fitNow());
    observer.observe(container);
    fitNow();
    // The container can settle after the synchronous first fit (sidebar
    // state, font swap, mobile view change): re-fit on the next frame, and
    // again on every replay so the ring-buffer content is drawn at the size
    // the pane actually has. The flush skips the debounce — the frame is
    // already the timing, and a late resize would leave the replay rendered
    // for a stale width.
    let frame: number | undefined;
    refitOnFrame = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        fitNow.flush();
      });
    };
    refitOnFrame();

    // Jump-to-bottom pill visibility: shown while the viewport sits above the
    // last line of the buffer. Driven by the viewport element's DOM scroll
    // event — xterm's onScroll fires only for buffer scrolls (live output),
    // not for wheel/touch scrolling through the scrollback — plus onScroll so
    // programmatic viewport moves without a DOM scroll are not missed.
    const viewportEl = container.querySelector<HTMLElement>(".xterm-viewport");
    const updateJump = () => {
      const buffer = term.buffer.active;
      onJump(buffer.viewportY < buffer.baseY);
    };
    const scrollSub = term.onScroll(updateJump);
    viewportEl?.addEventListener("scroll", updateJump);

    connection.attach(sessionId, term.cols, term.rows);

    return () => {
      sendRef.current = null;
      termRef.current = null;
      scrollSub.dispose();
      viewportEl?.removeEventListener("scroll", updateJump);
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      // Cancel a pending trailing fit so teardown never fits a disposed terminal.
      fitNow.dispose();
      batcher.close();
      connection.detach();
      term.dispose();
    };
  }, [sessionId, containerRef, sendRef, termRef, onStatus, onJump]);
}

/**
 * Installs the touch-scroll takeover on the mounted terminal as the
 * touch-device flag changes. Lives behind the pane's own mount effect, so it
 * only ever sees a live terminal — fine-pointer devices keep xterm's built-in
 * touch path untouched.
 */
function useTouchScroll(termRef: RefObject<XTerm | null>, coarsePointer: boolean): void {
  useEffect(() => {
    const term = termRef.current;
    if (!coarsePointer || !term) return;
    const element = term.element;
    const viewport = element?.querySelector<HTMLElement>(".xterm-viewport");
    if (!element || !viewport) return;
    const controller = createTouchScrollController({
      element,
      viewport,
      textarea: term.textarea ?? null,
    });
    return () => controller.dispose();
  }, [coarsePointer, termRef]);
}

export function Terminal({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Live handle onto the pane's input path for the mobile key row and
  // composer: set once the batcher exists, cleared on teardown. Both send
  // through the same batcher as keystrokes, so bursts coalesce too.
  const sendRef = useRef<((data: string) => void) | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [scrolledUp, setScrolledUp] = useState(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  // Stable identity: the mount effect keys on these, and rebuilding the
  // terminal because the status pill re-rendered would reset the pane.
  const onStatus = useCallback((next: TerminalStatus) => setStatus(next), []);
  const onJump = useCallback((up: boolean) => setScrolledUp(up), []);
  useTerminalMount(sessionId, containerRef, sendRef, termRef, onStatus, onJump);
  const coarsePointer = useCoarsePointer();
  useMobileTextareaGate(termRef, coarsePointer);
  useTouchScroll(termRef, coarsePointer);

  const handleCtrlKey = useCallback(
    (key: string): boolean => {
      const seq = ctrlArmed ? controlSeq(key) : null;
      if (seq) sendRef.current?.(seq);
      setCtrlArmed(false);
      return seq !== null;
    },
    [ctrlArmed],
  );

  const jumpToBottom = () => {
    const term = termRef.current;
    if (!term) return;
    term.scrollToBottom();
    term.focus();
  };

  const send = (seq: string) => sendRef.current?.(seq);

  return (
    <div className="terminal-pane">
      <div className="terminal-body">
        <div ref={containerRef} className="terminal-screen" />
        {disconnected(status) && (
          <div className="terminal-status" role="status">
            {STATUS_LABELS[status]}
          </div>
        )}
        {scrolledUp && (
          <button type="button" className="terminal-jump" aria-label="Jump to bottom" onClick={jumpToBottom}>
            ↓
          </button>
        )}
      </div>
      {coarsePointer && (
        <div className="terminal-keyrow" role="group" aria-label="Terminal keys">
          {TERMINAL_KEYS.slice(0, 2).map((key) => (
            <KeyButton key={key.label} label={key.label} name={key.name} seq={key.seq} onSend={send} />
          ))}
          <button
            type="button"
            className={`terminal-key${ctrlArmed ? " terminal-key-armed" : ""}`}
            aria-pressed={ctrlArmed}
            aria-label="Control"
            onPointerDown={(event) => {
              event.preventDefault();
              setCtrlArmed((armed) => !armed);
            }}
          >
            Ctrl
          </button>
          {TERMINAL_KEYS.slice(2).map((key) => (
            <KeyButton key={key.label} label={key.label} name={key.name} seq={key.seq} onSend={send} />
          ))}
        </div>
      )}
      {coarsePointer && (
        <MobileComposer onSend={(payload) => sendRef.current?.(payload)} ctrlArmed={ctrlArmed} onCtrlKey={handleCtrlKey} />
      )}
    </div>
  );
}

/**
 * One key-row button. Pointer presses send on pointerdown — preventDefault
 * keeps focus on the xterm textarea (no keyboard steal) and suppresses touch
 * scroll/zoom under the finger. A click with detail 0 is keyboard activation.
 */
function KeyButton(props: { label: string; name?: string; seq: string; onSend: (seq: string) => void }) {
  const { label, name, seq, onSend } = props;
  return (
    <button
      type="button"
      className="terminal-key"
      aria-label={name ?? label}
      onPointerDown={(event) => {
        event.preventDefault();
        onSend(seq);
      }}
      onClick={(event) => {
        // Pointer presses already sent on pointerdown; a click with detail 0
        // is keyboard activation (Enter/Space).
        if (event.detail === 0) onSend(seq);
      }}
    >
      {label}
    </button>
  );
}