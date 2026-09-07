/**
 * Board column rendering shared by the per-project board and the
 * all-projects combined board (issue #62): merges the given boards into the
 * shared `KANBAN_COLUMNS` order — every column is rendered exactly once, the
 * cards of all boards concatenated in board order.
 */

import { KANBAN_COLUMNS, type KanbanBoard } from "@agentskiss/shared";
import { BoardColumn, prKey, type CardDetails } from "./BoardColumn";
import type { PullRequest } from "@agentskiss/shared";

/** Merges the given boards' PRs into a single card-detail lookup. */
export function mergedCardDetails(boards: KanbanBoard[], pullRequests: Record<string, PullRequest[]>): CardDetails {
  const map = new Map<string, PullRequest>();
  for (const board of boards) {
    for (const pr of pullRequests[board.projectId] ?? []) {
      map.set(prKey(pr.projectId, pr.number), pr);
    }
  }
  return { pullRequests: map };
}

/**
 * The `.board` grid: one column per shared kanban column, cards from every
 * given board merged in.
 */
export function BoardColumns({ boards, details }: { boards: KanbanBoard[]; details: CardDetails }) {
  return (
    <div className="board">
      {KANBAN_COLUMNS.map((column) => {
        const cards = boards.flatMap((board) => board.columns.find((entry) => entry.column === column)?.cards ?? []);
        return <BoardColumn key={column} summary={{ column, cards }} details={details} />;
      })}
    </div>
  );
}
