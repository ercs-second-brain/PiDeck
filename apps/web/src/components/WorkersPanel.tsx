import { Link } from "react-router";
import type { Worker } from "@agentskiss/shared";

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Workers panel for one project. Freeform workers (`issueNumber: 0`, spawned
 * from a plain task prompt) have no kanban card of their own — this panel is
 * where they (and every other live worker) are visible, with a jump into the
 * worker's browser terminal session.
 *
 * Archived workers (issue #102) are filtered out here: terminated workers
 * disappear from the kanban panel and live only in the terminal sidebar's
 * archived section (the workers endpoint still serves them for history).
 */
export function WorkersPanel({ projectId, workers: allWorkers }: { projectId: string; workers: Worker[] }) {
  const workers = allWorkers.filter((worker) => worker.status !== "archived");
  return (
    <section className="workers-panel">
      <header className="panel-header">
        <h2 className="panel-title">Workers</h2>
        <span className="panel-count">{workers.length}</span>
      </header>
      {workers.length === 0 && <p className="empty">No workers running.</p>}
      <ul className="worker-list">
        {workers.map((worker) => (
          <li key={worker.id} className={`worker-row worker-${worker.status}`}>
            <span className="worker-id" title={worker.id}>
              {worker.id}
            </span>
            <span className={`badge badge-status badge-status-${worker.status}`}>{worker.status}</span>
            <span className="worker-scope">
              {worker.issueNumber === 0 ? (
                <span className="badge badge-freeform">freeform</span>
              ) : (
                <span className="worker-issue">issue #{worker.issueNumber}</span>
              )}
              {worker.prNumber !== null && (
                <Link className="worker-pr" to={`/projects/${projectId}/pulls/${worker.prNumber}`}>
                  PR #{worker.prNumber}
                </Link>
              )}
            </span>
            {worker.statusMessage && <span className="worker-message">{worker.statusMessage}</span>}
            <Link className="worker-terminal" to={`/terminal/${worker.sessionId}`} title="Open worker terminal">
              ⌨ terminal
            </Link>
            <span className="card-time">{formatTimestamp(worker.updatedAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
