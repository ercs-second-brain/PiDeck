import type { Issue, KanbanCard, KanbanColumnSummary, PullRequest } from "@agentskiss/shared";
import { COLUMN_LABELS } from "../lib/kanban";
import { KanbanCardView } from "./KanbanCardView";

export interface CardDetails {
  issues: Map<number, Issue>;
  pullRequests: Map<number, PullRequest>;
}

/** One board column: header + the cards currently in it. */
export function BoardColumn({ summary, details }: { summary: KanbanColumnSummary; details: CardDetails }) {
  const lookup = (card: KanbanCard): Issue | PullRequest | undefined =>
    card.kind === "issue" ? details.issues.get(card.number) : details.pullRequests.get(card.number);

  return (
    <section className={`column column-${summary.column}`}>
      <header className="column-header">
        <span className="column-label">{COLUMN_LABELS[summary.column]}</span>
        <span className="column-count">{summary.cards.length}</span>
      </header>
      <div className="column-cards">
        {summary.cards.map((card) => (
          <KanbanCardView key={card.id} card={card} detail={lookup(card)} />
        ))}
        {summary.cards.length === 0 && <div className="column-empty">empty</div>}
      </div>
    </section>
  );
}
