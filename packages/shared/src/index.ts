/**
 * @pideck/shared — shared contracts for PiDeck.
 *
 * Exports:
 * - Domain model (zod schemas + TS types): Project, Issue, PullRequest,
 *   KanbanCard/KanbanColumn/KanbanBoard, Session, Worker, WorkerStatus.
 * - Typed REST API surface: documented endpoint map with request/response
 *   schema types and a `formatPath` helper.
 * - WebSocket event schema: terminal attach/data/resize/reconnect/detach
 *   messages and kanban/project/worker update events.
 * - GitHub watcher event union (`GithubWatcherEvent`): issue created/assigned
 *   and PR opened/updated transitions emitted by the daemon's watchers.
 */

export * from "./domain.js";
export * from "./rest.js";
export * from "./ws.js";
