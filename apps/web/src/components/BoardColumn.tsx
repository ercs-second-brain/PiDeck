import type { KanbanCard, KanbanColumnSummary, PullRequest } from "@agentskiss/shared";
import { COLUMN_LABELS } from "../lib/kanban";
import { KanbanCardView } from "./KanbanCardView";

export interface CardDetails {
  pullRequests: Map<number, PullRequest>;
}

/** One board column: header + the cards currently in it. */
export function BoardColumn({ summary, details }: { summary: KanbanColumnSummary; details: CardDetails }) {
  return (
    <section className={`column column-${summary.column}`}>
      <header className="column-header">
        <span className="column-label">{COLUMN_LABELS[summary.column]}</span>
        <span className="column-count">{summary.cards.length}</span>
      </header>
      <div className="column-cards">
        {summary.cards.map((card: KanbanCard) => (
          <KanbanCardView key={card.id} card={card} pr={details.pullRequests.get(card.number)} />
        ))}
        {summary.cards.length === 0 && <div className="column-empty">empty</div>}
      </div>
    </section>
  );
}
