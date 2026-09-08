/**
 * Read-only archived worker log view (issue #104): the tmux scrollback
 * captured when the worker's pane was terminated, plus the worker's final
 * metadata (task, PR, final status, timestamps). Rendered by the terminal
 * main pane when an archived worker's session is selected in the sidebar.
 *
 * {@link ArchivedLogPanel} is the pure presentational piece (exported for
 * tests); {@link ArchivedLogView} fetches the log and handles load/error.
 */

import { useEffect, useState } from "react";
import type { ArchivedWorkerLog } from "@pideck/shared";
import { fetchArchivedWorkerLog } from "../lib/api";
import { formatTimestamp } from "../lib/format-timestamp";

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
        {log.scrollback.length > 0 ? log.scrollback : "(no scrollback captured — the pane was already gone at termination)"}
      </pre>
      <p className="archived-log-hint">
        Read-only: this worker's pane was terminated; the scrollback above was captured at termination.
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
