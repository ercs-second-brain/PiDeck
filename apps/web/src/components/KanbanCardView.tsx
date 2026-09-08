import { Link } from "react-router";
import type { KanbanCard, PullRequest } from "@agentskiss/shared";

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const CI_LABELS = {
  pending: "CI pending",
  running: "CI running",
  success: "CI ✓",
  failure: "CI ✗",
  unknown: "CI ?",
} as const;

const REVIEW_LABELS = {
  none: null,
  pending: "review pending",
  approved: "review ✓",
  changes_requested: "changes requested",
} as const;

/**
 * A single kanban card. Issues and PRs are visually distinguishable via a
 * type badge and accent color. `pr` — the underlying PR entity from the
 * daemon, when available — contributes state badges: PR state, CI status,
 * review decision, branch info, and a link to the diff-review view. The
 * worker badge (when a worker drives the card) links to the per-worker
 * files-changed view (issue #126) — its PR files, or its branch diff vs the
 * default branch while work is still mid-flight.
 */
export function KanbanCardView({ card, pr }: { card: KanbanCard; pr?: PullRequest }) {
  return (
    <article className={`card card-${card.kind}`}>
      <div className="card-top">
        <span className={`kind-badge kind-${card.kind}`}>
          {card.kind === "issue" ? "◆ Issue" : "⇅ Pull Request"}
        </span>
        <span className="card-number">#{card.number}</span>
      </div>
      <div className="card-title">{card.title}</div>
      <div className="card-meta">
        {card.kind === "issue" ? <IssueBadges card={card} /> : <PrBadges card={card} pr={pr} />}
        {card.workerId !== null && <WorkerFilesLink projectId={card.projectId} workerId={card.workerId} />}
        <span className="card-time">{formatTimestamp(card.updatedAt)}</span>
      </div>
    </article>
  );
}

/** Worker badge linking to the worker's files-changed view (issue #126). */
function WorkerFilesLink({ projectId, workerId }: { projectId: string; workerId: string }) {
  return (
    <Link
      className="badge badge-worker card-worker-link"
      title="Files changed by this worker"
      to={`/projects/${projectId}/pulls/${workerId}`}
    >
      ⚒ {workerId}
    </Link>
  );
}

function IssueBadges({ card }: { card: KanbanCard }) {
  // Issue entities are not shipped to the client; column placement (from the
  // daemon) encodes the state: `done` means the issue is closed.
  const state = card.column === "done" ? "closed" : "open";
  return <span className={`badge badge-${state}`}>{state}</span>;
}

function PrBadges({ card, pr }: { card: KanbanCard; pr?: PullRequest }) {
  if (pr === undefined) {
    return (
      <>
        <span className="badge badge-open">open</span>
        <DiffLink card={card} />
      </>
    );
  }
  const review = REVIEW_LABELS[pr.reviewState];
  return (
    <>
      <span className={`badge badge-${pr.state === "merged" ? "merged" : pr.state}`}>{pr.state}</span>
      <span className={`badge badge-ci badge-ci-${pr.ciStatus}`}>{CI_LABELS[pr.ciStatus]}</span>
      {review && <span className="badge badge-review">{review}</span>}
      <span className="badge badge-branch" title={`${pr.headBranch} → ${pr.baseBranch}`}>
        {pr.headBranch}
      </span>
      {pr.state === "open" && <DiffLink card={card} />}
    </>
  );
}

/** Link to the diff-review view for open PRs. */
function DiffLink({ card }: { card: KanbanCard }) {
  return (
    <Link className="card-diff-link" to={`/projects/${card.projectId}/pulls/${card.number}`}>
      diff
    </Link>
  );
}
