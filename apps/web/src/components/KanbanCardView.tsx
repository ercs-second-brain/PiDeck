import type { Issue, KanbanCard, PullRequest } from "@agentskiss/shared";

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
 * type badge and accent color. `detail` — the underlying shared entity, when
 * available — contributes state badges: issue state, PR CI status, review
 * decision, branch info.
 */
export function KanbanCardView({ card, detail }: { card: KanbanCard; detail?: Issue | PullRequest }) {
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
        {card.kind === "issue" ? <IssueBadges detail={detail} /> : <PrBadges detail={detail} />}
        {card.workerId && <span className="badge badge-worker">⚒ {card.workerId}</span>}
        <span className="card-time">{formatTimestamp(card.updatedAt)}</span>
      </div>
    </article>
  );
}

function IssueBadges({ detail }: { detail?: Issue | PullRequest }) {
  const state = detail && "headBranch" in detail ? "open" : (detail?.state ?? "open");
  return <span className={`badge badge-${state === "closed" ? "closed" : "open"}`}>{state}</span>;
}

function PrBadges({ detail }: { detail?: Issue | PullRequest }) {
  if (!detail || !("headBranch" in detail)) {
    return <span className="badge badge-open-pr">open</span>;
  }
  const review = REVIEW_LABELS[detail.reviewState];
  return (
    <>
      <span className={`badge badge-${detail.state === "merged" ? "merged" : detail.state}`}>{detail.state}</span>
      <span className={`badge badge-ci badge-ci-${detail.ciStatus}`}>{CI_LABELS[detail.ciStatus]}</span>
      {review && <span className="badge badge-review">{review}</span>}
      <span className="badge badge-branch" title={`${detail.headBranch} → ${detail.baseBranch}`}>
        {detail.headBranch}
      </span>
    </>
  );
}
