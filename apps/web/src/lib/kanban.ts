/**
 * Board rendering helpers.
 *
 * Column placement is **server-derived** (the daemon's KanbanService owns
 * the issue/PR → column rules and pushes card moves over `/api/ws`); the
 * webapp renders whatever board it receives.
 */

import { KANBAN_COLUMNS, type KanbanColumn } from "@pideck/shared";

/** Human-readable column labels, keyed by shared `KanbanColumn`. */
export const COLUMN_LABELS: Record<KanbanColumn, string> = {
  backlog: "Backlog",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
};

/** Compile-time guard that every shared column has a label. */
const ALL_COLUMNS_LABELED: readonly KanbanColumn[] = KANBAN_COLUMNS;
void ALL_COLUMNS_LABELED;
