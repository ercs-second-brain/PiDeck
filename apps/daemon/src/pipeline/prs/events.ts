/**
 * Typed events emitted by the PR lifecycle pipeline (issue #11).
 *
 * These are the kanban-facing contract the API layer (#9) subscribes to:
 * - `kanban.pr.card` — upsert of the PR's kanban card. The card column
 *   carries the state transition: `in_review` while the PR is open,
 *   `done` once the PR is merged or CI-green + approved.
 * - `kanban.pr.failed` — terminal failure of the PR loop (fix-attempt
 *   limit exhausted, PR closed without merging, owning worker lost). The
 *   API layer decides how to present failure; the card itself keeps its
 *   last known column.
 * - `notification.pr.merged` — user-facing merged-PR notification
 *   (issue #111, agent-orchestrator's `pr_merged` kind): the wiring
 *   forwards it onto the WS hub as a shared `notification.pr.merged` event
 *   so the webapp can toast it. Emitted once per merge (the PR drops out
 *   of the active list as `done`).
 * - `notification.pr.ready_for_merge` — the orchestrator notification
 *   (issue #408): the PR is CI-green, approved, and both the author worker
 *   and the reviewer are idle. The wiring forwards it onto the WS hub as a
 *   shared `NotificationEvent` (webapp toast/notification center) and —
 *   issue #490 — types it into the owning project's orchestrator pane, so
 *   the orchestrator is notified deterministically (merging stays
 *   human/orchestrator-approved — this only notifies).
 */

import type { KanbanCard } from "@pideck/shared";

export type PRPipelineEvent =
  | {
      type: "kanban.pr.card";
      at: string;
      /** Full updated card, so subscribers can upsert it wholesale. */
      card: KanbanCard;
    }
  | {
      type: "kanban.pr.failed";
      at: string;
      projectId: string;
      prNumber: number;
      workerId: string;
      /** Last known card state at the moment of failure. */
      card: KanbanCard;
      /** Machine-readable failure reason (e.g. `fix_attempt_limit_exhausted`). */
      reason: string;
    }
  | {
      type: "notification.pr.merged";
      at: string;
      projectId: string;
      prNumber: number;
      /** PR title at merge time, for the webapp toast. */
      title: string;
    }
  | {
      type: "notification.pr.ready_for_merge";
      at: string;
      projectId: string;
      prNumber: number;
      /** PR title, for the webapp toast/notification center. */
      title: string;
    };

export type PRPipelineEventEmitter = (event: PRPipelineEvent) => void;
