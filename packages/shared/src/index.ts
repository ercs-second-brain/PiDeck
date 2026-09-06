/**
 * @agentskiss/shared — shared contracts for agentsKISS.
 *
 * Exports:
 * - Domain model (zod schemas + TS types): Project, Issue, PullRequest,
 *   KanbanCard/KanbanColumn/KanbanBoard, Session, Worker, WorkerStatus.
 * - Typed REST API surface: documented endpoint map with request/response
 *   schema types and a `formatPath` helper.
 * - WebSocket event schema: terminal attach/data/resize/reconnect/detach
 *   messages and kanban/project/worker update events.
 */

export * from "./domain.js";
export * from "./rest.js";
export * from "./ws.js";

// --- Deprecated placeholder compatibility shim -----------------------------

/**
 * @deprecated Kept only so the Phase 0 app scaffolds (apps/daemon,
 * apps/web) keep compiling. Remove once the apps stop importing it.
 */
export const PACKAGE_NAME = "@agentskiss/shared";

/**
 * @deprecated See {@link PACKAGE_NAME}.
 */
export function placeholder(): string {
  return `${PACKAGE_NAME} placeholder`;
}
