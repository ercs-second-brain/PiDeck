/**
 * Kanban broadcast bridge (issue #46 wiring, extracted).
 *
 * Converts the issue pipeline's `kanban.card.moved` events and the PR
 * pipelines' card events to shared `KanbanUpdateEvent`s and broadcasts
 * them on the WS hub, so connected webapps see boards move live. The PR
 * pipelines' user-facing `notification.pr.merged` event (issue #111) is
 * forwarded 1:1 as a shared `NotificationEvent` on the same hub.
 *
 * The per-card `lastColumns` map exists only to synthesize the `from`
 * column of `kanban.card.moved` for PR cards (PR card events carry only
 * the new column). It is per project and dropped when the project's unit
 * is stopped/rebuilt.
 */

import type { KanbanColumn, WsServerEvent } from "@pideck/shared";

import type { PRPipelineEvent } from "./prs/events.js";

export class KanbanBridge {
  /** projectId → (PR card id → last broadcast column). */
  private readonly lastColumns = new Map<string, Map<string, KanbanColumn>>();

  constructor(
    private readonly hub: { broadcast(event: WsServerEvent): void },
    private readonly onError: (err: unknown, where: string) => void,
  ) {}

  /** Forgets a project's last-column state (unit stopped/rebuilt). */
  forget(projectId: string): void {
    this.lastColumns.delete(projectId);
  }

  /** Ensures the per-project column map exists, then synthesizes `from`. */
  broadcastPrEvent(projectId: string, event: PRPipelineEvent): void {
    if (event.type === "notification.pr.merged") {
      this.broadcast(
        {
          type: "notification.pr.merged",
          at: event.at,
          projectId: event.projectId,
          prNumber: event.prNumber,
          title: event.title,
        },
        `kanban:${projectId}`,
      );
      return;
    }
    if (event.type !== "kanban.pr.card") return;
    let columns = this.lastColumns.get(projectId);
    if (columns === undefined) {
      columns = new Map();
      this.lastColumns.set(projectId, columns);
    }
    const from = columns.get(event.card.id) ?? event.card.column;
    columns.set(event.card.id, event.card.column);
    this.broadcast(
      {
        type: "kanban.card.moved",
        at: event.at,
        projectId: event.card.projectId,
        cardId: event.card.id,
        from,
        to: event.card.column,
        card: event.card,
      },
      `kanban:${projectId}`,
    );
  }

  /** Broadcasts a pre-formed kanban/notification update (e.g. the issue pipeline's card moves). */
  broadcast(event: WsServerEvent, where: string): void {
    try {
      this.hub.broadcast(event);
    } catch (err) {
      this.onError(err, where);
    }
  }
}
