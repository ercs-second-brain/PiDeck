/**
 * Full-attach browser terminal for one tmux session: xterm.js + fit addon,
 * wired to a {@link TerminalConnection}. Output frames (including the
 * scrollback replay on attach/reconnect) are written as they arrive;
 * keystrokes are forwarded; container resizes propagate to tmux.
 */

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { InputBatcher } from "./input-batcher";
import { TerminalConnection, type TerminalStatus } from "./connection";
import { TERMINAL_KEYS } from "./keys";

const STATUS_LABELS: Record<TerminalStatus, string> = {
  connecting: "Connecting…",
  attached: "Attached",
  reconnecting: "Reconnecting…",
  exited: "Session ended",
  unavailable: "Session unavailable",
  detached: "Detached",
};

export function TerminalPane({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Live handle onto the pane's input path for the mobile key row (issue
  // #105): set once the batcher exists, cleared on teardown. The key row
  // sends through the same batcher as keystrokes, so bursts coalesce too.
  const sendRef = useRef<((data: string) => void) | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [detail, setDetail] = useState<string | undefined>(undefined);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      scrollback: 5000,
      fontSize: 14,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      cursorBlink: true,
      theme: {
        background: "#0f1216",
        foreground: "#e6e2d8",
        cursor: "#e6e2d8",
        selectionBackground: "#3a4453",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    const connection = new TerminalConnection({
      onData: (data) => term.write(data),
      onStatus: (next, why) => {
        setStatus(next);
        setDetail(why);
      },
      onReplay: () => term.reset(),
    });
    // Coalesce keystroke bursts into fewer, larger WS frames (issue #67).
    const batcher = new InputBatcher((data) => connection.sendInput(data));
    term.onData((data) => batcher.add(data));
    sendRef.current = (data) => batcher.add(data);

    let lastSent = { cols: term.cols, rows: term.rows };
    const propagateResize = () => {
      if (term.cols !== lastSent.cols || term.rows !== lastSent.rows) {
        lastSent = { cols: term.cols, rows: term.rows };
        connection.resize(term.cols, term.rows);
      }
    };
    const fitNow = () => {
      try {
        fit.fit();
      } catch {
        // Container not measurable yet (hidden during transition) — the
        // next observer event will fit.
      }
      propagateResize();
    };
    const observer = new ResizeObserver(fitNow);
    observer.observe(container);
    fitNow();

    connection.attach(sessionId, term.cols, term.rows);

    return () => {
      sendRef.current = null;
      observer.disconnect();
      batcher.close();
      connection.detach();
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div className="terminal-pane">
      <div ref={containerRef} className="terminal-container" />
      <KeyRow onSend={(data) => sendRef.current?.(data)} />
      <div className={`terminal-statusbar status-${status}`}>
        <span className="terminal-status-label">{STATUS_LABELS[status]}</span>
        {detail && <span className="terminal-status-detail">{detail}</span>}
      </div>
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
