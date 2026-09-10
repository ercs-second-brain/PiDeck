/**
 * Full-attach browser terminal for one tmux session: xterm.js + fit addon,
 * wired to a {@link TerminalConnection}. Output frames (including the
 * scrollback replay on attach/reconnect) are written as they arrive;
 * keystrokes are forwarded; container resizes propagate to tmux.
 *
 * Mobile input (issue #374): on touch devices the OS keyboard never types
 * into xterm's hidden textarea — all composed text enters through a
 * dedicated visible input field (see ./mobile-input.tsx for the duplication
 * mechanism this closes) and is sent to the pane verbatim once, with the
 * trailing Enter. Keystroke bytes still flow through the one batcher.
 *
 * Mobile scrolling (issue #375): on those same devices swipes scroll xterm's
 * scrollback like desktop mouse-wheel scrolls do — see ./touch-scroll.ts for
 * why xterm 5.5's built-in touch path cannot.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";
import { relaunchSession } from "../lib/api";
import { InputBatcher } from "./input-batcher";
import { TerminalConnection, type TerminalStatus } from "./connection";
import { createFitController } from "./terminal-fit";
import { TERMINAL_THEME } from "./terminal-theme";
import { TERMINAL_KEYS } from "./keys";
import { MobileComposer, useCoarsePointer, useMobileTextareaGate } from "./mobile-input";
import { createTouchScrollController } from "./touch-scroll";

const STATUS_LABELS: Record<TerminalStatus, string> = {
  connecting: "Connecting…",
  attached: "Attached",
  reconnecting: "Reconnecting…",
  exited: "Session ended",
  unavailable: "Session unavailable",
  detached: "Detached",
};

/**
 * Whether the status bar should offer the relaunch affordance (issue #117):
 * the pane is dead — the tmux session ended (`terminal.exited`) or no
 * longer exists — so instead of a dead end the user can restart it. Live
 * and transitioning states never offer it; archived sessions never reach
 * this pane at all (they render the read-only archived log view).
 */
export function relaunchOffered(status: TerminalStatus): boolean {
  return status === "exited" || status === "unavailable";
}

/** Refs and state the mount effect wires together for one pane instance. */
interface PaneRefs {
  sessionId: string;
  containerRef: RefObject<HTMLDivElement | null>;
  sendRef: RefObject<((data: string) => void) | null>;
  connectionRef: RefObject<TerminalConnection | null>;
  sizeRef: RefObject<{ cols: number; rows: number }>;
  termRef: RefObject<Terminal | null>;
  /** Status-bar updates from the connection (component state lives there). */
  onStatus: (status: TerminalStatus, detail?: string) => void;
}

/**
 * Mount/teardown of one terminal instance: builds the xterm surface, wires
 * output, keystroke batching (issue #67), fit, touch scrolling (issue #375),
 * and the session attach, and undoes all of it on unmount. Split out of
 * {@link TerminalPane} so the component stays under the repo's per-function
 * line budget.
 */
function useTerminalMount(refs: PaneRefs): void {
  const { sessionId, containerRef, sendRef, connectionRef, sizeRef, termRef, onStatus } = refs;
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      scrollback: 5000,
      fontSize: 14,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      cursorBlink: true,
      // Terminal theme (issues #299 + #376): app surface + standard-hue ANSI
      // palette — see ./terminal-theme.ts for the #376 root-cause notes.
      theme: TERMINAL_THEME,
      // Issue #376: no forced contrast transform — xterm's contrast feature
      // rewrites each cell's foreground against its local background, so the
      // same ANSI color shifted inside TUI highlight blocks/selections (the
      // reported "colors move around"). The palette needs no rescue.
      minimumContrastRatio: 1,
      // Standard terminal semantics: bold selects the bright palette.
      drawBoldTextInBrightColors: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    // Issue #376: rasterize on a fixed cell grid (agent-orchestrator's
    // renderer chain) — the DOM renderer snaps per-span boxes on fractional
    // device pixel ratios and drifts box-drawing glyphs.
    loadRenderer(term);

    const connection = new TerminalConnection({
      onData: (data) => term.write(data),
      onStatus,
      onReplay: () => term.reset(),
    });
    connectionRef.current = connection;
    // Coalesce keystroke bursts into fewer, larger WS frames (issue #67).
    const batcher = new InputBatcher((data) => connection.sendInput(data));
    term.onData((data) => batcher.add(data));
    sendRef.current = (data) => batcher.add(data);

    const fitNow = createFitController({
      terminal: term,
      fit: () => fit.fit(),
      connection,
      onFitted: (size) => {
        sizeRef.current = size;
      },
    });
    const observer = new ResizeObserver(fitNow);
    observer.observe(container);
    fitNow();

    connection.attach(sessionId, term.cols, term.rows);

    return () => {
      sendRef.current = null;
      connectionRef.current = null;
      termRef.current = null;
      observer.disconnect();
      // Cancel a pending trailing fit so teardown never fits a disposed
      // terminal (the fit controller coalesces resize bursts, issue #353).
      fitNow.dispose();
      batcher.close();
      connection.detach();
      term.dispose();
    };
  }, [sessionId, containerRef, sendRef, connectionRef, sizeRef, termRef, onStatus]);
}

/**
 * Installs the touch-scroll takeover (issue #375) on the mounted terminal as
 * the touch-device flag changes. Lives behind the pane's own mount effect, so
 * it only ever sees a live terminal — the same lifecycle as the textarea
 * gate above, and gated by the same coarse-pointer flag: fine-pointer
 * devices keep xterm's built-in touch path untouched.
 */
function useTouchScroll(
  termRef: RefObject<Terminal | null>,
  coarsePointer: boolean,
): void {
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

/**
 * Relaunch state + handler (issue #117): calls the daemon's relaunch
 * endpoint (which kills any lingering tmux session and re-runs the
 * session's launch path), then re-attaches the terminal with the
 * last-known pane size. Failures surface in the status bar and leave the
 * affordance available for a retry.
 */
function useRelaunch(
  sessionId: string,
  connectionRef: RefObject<TerminalConnection | null>,
  sizeRef: RefObject<{ cols: number; rows: number }>,
) {
  const [relaunching, setRelaunching] = useState(false);
  const [relaunchError, setRelaunchError] = useState<string | null>(null);
  const relaunch = async () => {
    if (relaunching) return;
    setRelaunching(true);
    setRelaunchError(null);
    try {
      await relaunchSession(sessionId);
      // Fresh attach (not reconnect): the pane is brand new, scrollback
      // replay comes from the daemon's retained history for the session.
      const { cols, rows } = sizeRef.current ?? { cols: 80, rows: 24 };
      connectionRef.current?.attach(sessionId, cols, rows);
    } catch (err) {
      setRelaunchError(err instanceof Error ? err.message : String(err));
    } finally {
      setRelaunching(false);
    }
  };
  return { relaunching, relaunchError, relaunch };
}

/**
 * Renderer selection (issue #376, agent-orchestrator's chain): prefer the
 * WebGL renderer, fall back to 2D canvas, and keep xterm's DOM renderer as
 * the last resort. Both canvas-based renderers rasterize box-drawing glyphs
 * themselves onto a fixed cell grid; the DOM renderer does not, so TUI
 * borders drift and background runs snap sub-pixel on fractional DPRs.
 * WebGL contexts can be lost (hidden tabs, GPU resets) — `onContextLoss`
 * swaps in the canvas renderer so the pane keeps rendering for the rest of
 * its life. Loaded after {@link Terminal.open}.
 */
function loadRenderer(term: Terminal): void {
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

export function TerminalPane({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Live handle onto the pane's input path for the mobile key row (issue
  // #105) and composer (issue #374): set once the batcher exists, cleared on
  // teardown. Both send through the same batcher as keystrokes, so bursts
  // coalesce too.
  const sendRef = useRef<((data: string) => void) | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [detail, setDetail] = useState<string | undefined>(undefined);
  // Stable identity: the mount effect keys on it, and rebuilding the
  // terminal because the status bar re-rendered would reset the pane.
  const onStatus = useCallback((next: TerminalStatus, why?: string) => {
    setStatus(next);
    setDetail(why);
  }, []);
  // Relaunch affordance state (issue #117): the live connection handle (so
  // the click can re-attach after the daemon recreated the pane) and the
  // last-known pane size for that re-attach.
  const connectionRef = useRef<TerminalConnection | null>(null);
  const sizeRef = useRef({ cols: 80, rows: 24 });
  const { relaunching, relaunchError, relaunch } = useRelaunch(sessionId, connectionRef, sizeRef);
  // Mobile input (issue #374): live touch-device flag driving both the
  // textarea lock-out (via useMobileTextareaGate) and the composer field.
  const coarsePointer = useCoarsePointer();
  // The mounted terminal, so the textarea gate can follow the device flag
  // without tearing the pane down.
  const termRef = useRef<Terminal | null>(null);
  useTerminalMount({
    sessionId,
    containerRef,
    sendRef,
    connectionRef,
    sizeRef,
    termRef,
    onStatus,
  });
  useMobileTextareaGate(termRef, coarsePointer);
  // Touch scrolling (issue #375): same flag, same install-once terminal.
  useTouchScroll(termRef, coarsePointer);

  return (
    <div className="terminal-pane">
      {/* The ref targets the inner, unpadded `.terminal-screen` box: the fit
          addon measures this element's parent and subtracts only the xterm
          element's own padding, so the padded `.terminal-container` must not
          be the measurement box — otherwise rows/cols are proposed for more
          space than is visible and the screen (background + scrollbar)
          overflows the pane (issue #258). */}
      <div className="terminal-container">
        <div ref={containerRef} className="terminal-screen" />
      </div>
      {/* Mobile composer (issue #374): the dedicated input field for touch
          devices — the keyboard types here, never into xterm's textarea, and
          Send delivers the composed text once with the trailing Enter. */}
      {coarsePointer && <MobileComposer onSend={(payload) => sendRef.current?.(payload)} />}
      <KeyRow onSend={(data) => sendRef.current?.(data)} />
      <StatusBar
        status={status}
        detail={detail}
        relaunching={relaunching}
        relaunchError={relaunchError}
        onRelaunch={relaunch}
      />
    </div>
  );
}

/**
 * Bottom status bar: connection state, optional detail text, and — only
 * while the pane is dead (exited/unavailable, issue #117) — the relaunch
 * button that restarts the tmux session without a dead end.
 */
export function StatusBar(props: {
  status: TerminalStatus;
  detail?: string;
  relaunching: boolean;
  relaunchError: string | null;
  onRelaunch: () => void;
}) {
  const { status, detail, relaunching, relaunchError, onRelaunch } = props;
  return (
    <div className={`terminal-statusbar status-${status}`}>
      <span className="terminal-status-label">{STATUS_LABELS[status]}</span>
      {detail && <span className="terminal-status-detail">{detail}</span>}
      {relaunchError && <span className="terminal-status-detail">Relaunch failed: {relaunchError}</span>}
      {relaunchOffered(status) && (
        <button
          type="button"
          className="terminal-relaunch"
          aria-label="Relaunch session"
          title="Kill any lingering tmux session of this name and restart it"
          disabled={relaunching}
          onClick={onRelaunch}
        >
          {relaunching ? "Relaunching…" : "↻ Relaunch"}
        </button>
      )}
    </div>
  );
}

/**
 * Mobile key row (issue #105): on-screen buttons for the keys a touch
 * keyboard lacks. Always rendered; the CSS hides it on desktop.
 */
function KeyRow({ onSend }: { onSend: (data: string) => void }) {
  return (
    <div className="terminal-keyrow" role="group" aria-label="Terminal keys">
      {TERMINAL_KEYS.map((key) => (
        <button
          key={key.label}
          type="button"
          className="terminal-key"
          aria-label={key.name ?? key.label}
          onPointerDown={(event) => {
            // preventDefault keeps focus on the xterm textarea (no keyboard
            // steal) and suppresses touch scroll/zoom under the finger.
            event.preventDefault();
            onSend(key.seq);
          }}
          onClick={(event) => {
            // Pointer presses already sent on pointerdown; a click with
            // detail 0 is keyboard activation (Enter/Space).
            if (event.detail === 0) onSend(key.seq);
          }}
        >
          {key.label}
        </button>
      ))}
    </div>
  );
}
