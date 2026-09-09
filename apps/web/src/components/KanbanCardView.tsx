import { Link } from "react-router";
import type { KanbanCard, PullRequest } from "@pideck/shared";
import { formatTimestamp } from "../lib/format-timestamp";

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
 *
 * Issue #261: the card links to the GitHub issue/PR when the board payload
 * carries its URL, and PR cards show +/- diff totals when the board payload
 * resolved them.
 */
export function KanbanCardView({ card, pr }: { card: KanbanCard; pr?: PullRequest }) {
  return (
    <article className={`card card-${card.kind} card-${card.column}`}>
      <div className="card-top">
        <span className={`kind-badge kind-${card.kind}`}>
          {card.kind === "issue" ? "◆ Issue" : "⇅ Pull Request"}
        </span>
        <span className="card-number">#{card.number}</span>
      </div>
      {card.url === undefined ? (
        <div className="card-title">{card.title}</div>
      ) : (
        <a className="card-title card-title-link" href={card.url} target="_blank" rel="noreferrer">
          {card.title}
        </a>
      )}
      <div className="card-meta">
        {card.kind === "issue" ? <IssueBadges card={card} /> : <PrBadges card={card} pr={pr} />}
        <DiffStat card={card} />
        {card.workerId !== null && <WorkerFilesLink projectId={card.projectId} workerId={card.workerId} />}
        <span className="card-time">{formatTimestamp(card.updatedAt)}</span>
      </div>
    </article>
  );
}

/**
 * +N/−M diff totals for PR cards (issue #261): rendered only when the board
 * payload resolved both counts (issues have no diff, and event-derived PR
 * cards may not carry the totals until the next board fetch).
 */
function DiffStat({ card }: { card: KanbanCard }) {
  if (card.kind !== "pull_request") return null;
  if (card.additions === undefined || card.deletions === undefined) return null;
  return (
    <span className="card-diffstat" title="Lines added / deleted">
      <span className="diffstat-additions">+{card.additions}</span>
      <span className="diffstat-deletions">−{card.deletions}</span>
    </span>
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
