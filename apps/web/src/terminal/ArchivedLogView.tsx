/**
 * Read-only archived worker log view (issue #104): the tmux scrollback
 * captured when the worker's pane was terminated, plus the worker's final
 * metadata (task, PR, final status, timestamps). Rendered by the terminal
 * main pane when an archived worker's session is selected in the sidebar.
 *
 * {@link ArchivedLogPanel} is the pure presentational piece (exported for
 * tests); {@link ArchivedLogView} fetches the log and handles load/error.
 */

import { useEffect, useState, type ReactNode } from "react";
import type { ArchivedWorkerLog } from "@pideck/shared";
import { fetchArchivedWorkerLog } from "../lib/api";
import { formatTimestamp } from "../lib/format-timestamp";

/** xterm.js's default 16-color palette (dark theme). */
const PALETTE_16 = [
  "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
];

/** The 256-color palette entry `n` as a CSS color. */
function paletteColor(n: number): string {
  if (n < 16) return PALETTE_16[n]!;
  if (n < 232) {
    const i = n - 16;
    const v = (c: number) => (c === 0 ? 0 : 55 + c * 40);
    return `rgb(${v(Math.floor(i / 36))},${v(Math.floor((i % 36) / 6))},${v(i % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

/** The subset of SGR state the log renderer tracks. */
interface AnsiStyle {
  color?: string;
  backgroundColor?: string;
  fontWeight?: 700;
  fontStyle?: "italic";
  textDecoration?: "underline";
}

/** Simple SGR parameter → style effect (reset/defaults/colors handled separately). */
const SGR_EFFECTS: Record<number, (style: AnsiStyle) => void> = {
  1: (s) => {
    s.fontWeight = 700;
  },
  3: (s) => {
    s.fontStyle = "italic";
  },
  4: (s) => {
    s.textDecoration = "underline";
  },
  22: (s) => {
    delete s.fontWeight;
  },
  23: (s) => {
    delete s.fontStyle;
  },
  24: (s) => {
    delete s.textDecoration;
  },
  39: (s) => {
    delete s.color;
  },
  49: (s) => {
    delete s.backgroundColor;
  },
};

/** Applies an extended (38/48) color; returns the extra params consumed. */
function applyExtendedColor(p: number[], i: number, style: AnsiStyle): number {
  const target = p[i] === 38 ? "color" : "backgroundColor";
  if (p[i + 1] === 5) {
    style[target] = paletteColor(p[i + 2]!);
    return 2;
  }
  if (p[i + 1] === 2) {
    style[target] = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`;
    return 4;
  }
  return 0;
}

/** Applies one SGR sequence's parameters to `style` in place (issue #443). */
function applySgr(params: string, style: AnsiStyle): void {
  const p = params.split(";").map((s) => (s === "" ? 0 : Number(s)));
  for (let i = 0; i < p.length; i++) {
    const n = p[i]!;
    if (n === 0) {
      Object.keys(style).forEach((k) => delete style[k as keyof AnsiStyle]);
      continue;
    }
    const effect = SGR_EFFECTS[n];
    if (effect) {
      effect(style);
      continue;
    }
    if (n >= 30 && n <= 37) style.color = PALETTE_16[n - 30];
    else if (n >= 90 && n <= 97) style.color = PALETTE_16[n - 82]!;
    else if (n >= 40 && n <= 47) style.backgroundColor = PALETTE_16[n - 40]!;
    else if (n >= 100 && n <= 107) style.backgroundColor = PALETTE_16[n - 92]!;
    else if (n === 38 || n === 48) i += applyExtendedColor(p, i, style);
  }
}

/**
 * Renders a captured scrollback (which keeps escape sequences since
 * issue #443) as styled spans. Pre-#443 plain-text archives pass through
 * unchanged; unknown escape sequences are dropped.
 */
function ansiToNodes(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const style: AnsiStyle = {};
  let key = 0;
  for (const part of text.split(/(\x1b\[[0-?]*[ -/]*[@-~])/)) {
    if (part === "") continue;
    if (part.startsWith("\x1b[")) {
      if (part.endsWith("m")) applySgr(part.slice(2, -1), style);
      continue;
    }
    if (Object.keys(style).length > 0) nodes.push(<span key={key++} style={{ ...style }}>{part}</span>);
    else nodes.push(part);
  }
  return nodes;
}

/** The worker's task: its issue, or "freeform" for prompt-spawned workers. */
function taskLabel(issueNumber: number): string {
  return issueNumber > 0 ? `issue #${issueNumber}` : "freeform task";
}

/**
 * Pure log view: metadata header (task, PR, final status, started/updated/
 * archived timestamps) over the captured scrollback, rendered read-only.
 */
export function ArchivedLogPanel(props: { log: ArchivedWorkerLog; prUrl?: string | null }) {
  const { log } = props;
  return (
    <div className="archived-log">
      <header className="archived-log-header">
        <h2 className="archived-log-title">
          Archived worker log <span className="worker-badge archived">archived</span>
        </h2>
        <dl className="archived-log-meta">
          <div className="archived-log-meta-item">
            <dt>Task</dt>
            <dd>{taskLabel(log.issueNumber)}</dd>
          </div>
          {log.prompt !== null && (
            <div className="archived-log-meta-item archived-log-prompt">
              <dt>Prompt</dt>
              <dd>{log.prompt}</dd>
            </div>
          )}
          {log.prNumber !== null && (
            <div className="archived-log-meta-item">
              <dt>PR</dt>
              <dd>
                {props.prUrl ? (
                  <a href={props.prUrl} target="_blank" rel="noreferrer">
                    #{log.prNumber}
                  </a>
                ) : (
                  `#${log.prNumber}`
                )}
              </dd>
            </div>
          )}
          <div className="archived-log-meta-item">
            <dt>Final status</dt>
            <dd>
              {log.finalStatus}
              {log.finalStatusMessage ? ` — ${log.finalStatusMessage}` : ""}
            </dd>
          </div>
          <div className="archived-log-meta-item">
            <dt>Started</dt>
            <dd>{formatTimestamp(log.startedAt)}</dd>
          </div>
          <div className="archived-log-meta-item">
            <dt>Last update</dt>
            <dd>{formatTimestamp(log.updatedAt)}</dd>
          </div>
          {log.capturedAt !== null && (
            <div className="archived-log-meta-item">
              <dt>Archived</dt>
              <dd>{formatTimestamp(log.capturedAt)}</dd>
            </div>
          )}
        </dl>
      </header>
      <pre className="archived-log-scrollback">
        {log.scrollback.length > 0 ? ansiToNodes(log.scrollback) : "(no scrollback captured — the pane was already gone at deletion)"}
      </pre>
      <p className="archived-log-hint">
        Read-only: this worker's pane was deleted; the scrollback above was captured at deletion.
      </p>
    </div>
  );
}

/** Fetches the archived log for a worker and renders {@link ArchivedLogPanel}. */
export function ArchivedLogView(props: { workerId: string; prUrl?: string | null }) {
  const [log, setLog] = useState<ArchivedWorkerLog | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLog(null);
    setError(null);
    fetchArchivedWorkerLog(props.workerId)
      .then((fetched) => {
        if (!cancelled) setLog(fetched);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [props.workerId]);

  if (error !== null) {
    return <div className="archived-log">Failed to load the archived log: {error}</div>;
  }
  if (log === null) {
    return <div className="archived-log">Loading archived log…</div>;
  }
  return <ArchivedLogPanel log={log} prUrl={props.prUrl} />;
}
