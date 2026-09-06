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
import { TerminalConnection, type TerminalStatus } from "./connection";

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
    term.onData((data) => connection.sendInput(data));

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
      observer.disconnect();
      connection.detach();
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div className="terminal-pane">
      <div ref={containerRef} className="terminal-container" />
      <div className={`terminal-statusbar status-${status}`}>
        <span className="terminal-status-label">{STATUS_LABELS[status]}</span>
        {detail && <span className="terminal-status-detail">{detail}</span>}
      </div>
    </div>
  );
}
