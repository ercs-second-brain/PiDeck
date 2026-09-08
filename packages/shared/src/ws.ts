/**
 * WebSocket message contracts for the daemon ⇄ webapp socket.
 *
 * Two families of messages:
 * - Terminal messages (attach / data / resize / reconnect / detach) bridge
 *   tmux sessions into browser terminals, including reconnect-and-resume.
 * - Kanban / project / worker update events push board changes so the
 *   webapp updates live (card moved, project updated, worker spawned).
 *
 * Every message is discriminated on its `type` field. Server events also
 * carry an `at` timestamp. Client→server: `WsClientMessage`.
 * Server→client: `WsServerEvent`.
 */

import { z } from "zod";
import {
  isoDateTimeSchema,
  issueSchema,
  kanbanCardSchema,
  kanbanColumnSchema,
  projectSchema,
  pullRequestSchema,
  refNumberSchema,
  workerSchema,
  workerStatusSchema,
} from "./domain.js";

// ---------------------------------------------------------------------------
// Shared fields
// ---------------------------------------------------------------------------

const sessionIdField = z.string().min(1);
const projectIdField = z.string().min(1);
const workerIdField = z.string().min(1);

const terminalSize = {
  cols: z.number().int().positive().max(1024),
  rows: z.number().int().positive().max(1024),
};

// ---------------------------------------------------------------------------
// Client → server: terminal messages
// ---------------------------------------------------------------------------

/**
 * Terminal client messages.
 *
 * - `terminal.attach` — attach to a session's tmux pane and start streaming.
 * - `terminal.data` — keystrokes / stdin for the session.
 * - `terminal.resize` — the browser terminal was resized.
 * - `terminal.reconnect` — re-attach after a dropped socket, replaying the
 *   server's retained scrollback so the conversation survives reconnects.
 * - `terminal.detach` — stop streaming; the tmux session keeps running.
 */
export const terminalClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("terminal.attach"), sessionId: sessionIdField, ...terminalSize }),
  z.object({ type: z.literal("terminal.data"), sessionId: sessionIdField, data: z.string() }),
  z.object({ type: z.literal("terminal.resize"), sessionId: sessionIdField, ...terminalSize }),
  z.object({ type: z.literal("terminal.reconnect"), sessionId: sessionIdField, ...terminalSize }),
  z.object({ type: z.literal("terminal.detach"), sessionId: sessionIdField }),
]);
export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;

// ---------------------------------------------------------------------------
// Server → client: terminal events
// ---------------------------------------------------------------------------

export const terminalServerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("terminal.attached"),
    at: isoDateTimeSchema,
    sessionId: sessionIdField,
    /** True when the attach resumed an existing (reconnected) session. */
    resumed: z.boolean(),
  }),
  z.object({
    type: z.literal("terminal.data"),
    at: isoDateTimeSchema,
    sessionId: sessionIdField,
    /** Raw terminal output chunk (UTF-8). */
    data: z.string(),
  }),
  z.object({
    type: z.literal("terminal.exited"),
    at: isoDateTimeSchema,
    sessionId: sessionIdField,
    /** Process exit code, or `null` if the tmux session died unexpectedly. */
    exitCode: z.number().int().nullable(),
  }),
]);
export type TerminalServerEvent = z.infer<typeof terminalServerEventSchema>;

// ---------------------------------------------------------------------------
// Server → client: kanban / project / worker update events
// ---------------------------------------------------------------------------

export const kanbanUpdateEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("kanban.card.moved"),
    at: isoDateTimeSchema,
    projectId: projectIdField,
    cardId: z.string().min(1),
    from: kanbanColumnSchema,
    to: kanbanColumnSchema,
    /** Full updated card, so clients can replace it wholesale. */
    card: kanbanCardSchema,
  }),
  z.object({
    type: z.literal("project.updated"),
    at: isoDateTimeSchema,
    project: projectSchema,
  }),
  z.object({
    type: z.literal("worker.spawned"),
    at: isoDateTimeSchema,
    worker: workerSchema,
  }),
  z.object({
    type: z.literal("worker.status.changed"),
    at: isoDateTimeSchema,
    projectId: projectIdField,
    workerId: workerIdField,
    status: workerStatusSchema,
  }),
]);
export type KanbanUpdateEvent = z.infer<typeof kanbanUpdateEventSchema>;

// ---------------------------------------------------------------------------
// GitHub watcher events (daemon-internal; may be forwarded over the socket)
// ---------------------------------------------------------------------------

/**
 * Typed events emitted by the daemon's GitHub watchers (issue + PR polling).
 *
 * Each event carries the full shared-contract entity at the moment of the
 * transition; `at` is when the watcher observed it. Consumed by the
 * orchestrator wiring (#9/#10/#11) so package-local event types are not
 * redefined per package.
 */
export const githubWatcherEventSchema = z.discriminatedUnion("type", [
  /** A newly seen issue (authored by, or assigned to, the watched login). */
  z.object({ type: z.literal("issue.created"), at: isoDateTimeSchema, issue: issueSchema }),
  /** The watched login became an assignee of a previously-seen issue. */
  z.object({ type: z.literal("issue.assigned"), at: isoDateTimeSchema, issue: issueSchema }),
  /** A PR was opened / newly seen by the PR watcher. */
  z.object({ type: z.literal("pull_request.opened"), at: isoDateTimeSchema, pullRequest: pullRequestSchema }),
  /** A previously-seen PR changed (title, state, CI status, or review decision). */
  z.object({ type: z.literal("pull_request.updated"), at: isoDateTimeSchema, pullRequest: pullRequestSchema }),
]);
export type GithubWatcherEvent = z.infer<typeof githubWatcherEventSchema>;

// ---------------------------------------------------------------------------
// Server → client: user notifications (issue #111)
// ---------------------------------------------------------------------------

/**
 * User-facing notification events (issue #111): things the user should
 * learn without staring at the board. Mirrors agent-orchestrator's
 * notification kinds — its `pr_merged` type (backend/internal/domain/
 * notification.go) — sliced to the merged-PR case; the union is open for
 * more kinds later. The PR pipeline emits the daemon-internal event, the
 * broadcast bridge forwards it here, and the webapp's toast surface
 * (mounted from main.tsx) renders it.
 */
export const notificationEventSchema = z.discriminatedUnion("type", [
  /** A tracked worker's PR merged (the PR loop observed the merge). */
  z.object({
    type: z.literal("notification.pr.merged"),
    at: isoDateTimeSchema,
    projectId: projectIdField,
    prNumber: refNumberSchema,
    /** PR title at merge time, for the toast's secondary line. */
    title: z.string().min(1),
  }),
]);
export type NotificationEvent = z.infer<typeof notificationEventSchema>;

// ---------------------------------------------------------------------------
// Full unions
// ---------------------------------------------------------------------------

/** Everything the server can send over the WebSocket. */
export const wsServerEventSchema = z.union([
  terminalServerEventSchema,
  kanbanUpdateEventSchema,
  notificationEventSchema,
]);
export type WsServerEvent = z.infer<typeof wsServerEventSchema>;
