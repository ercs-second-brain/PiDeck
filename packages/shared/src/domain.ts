/**
 * Domain model for agentsKISS.
 *
 * These schemas are the single source of truth for every entity shared
 * between the daemon, the webapp, and the pi agent integration. Each zod
 * schema doubles as its TypeScript type via `z.infer`.
 *
 * Scope guardrails (PRD non-goals): no auth models, no chat-UI schemas,
 * GitHub-only forge concepts (issues + pull requests, no multi-forge).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ISO-8601 UTC date-time string, e.g. `2025-01-01T12:00:00.000Z`. */
export const isoDateTimeSchema = z.iso.datetime();
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;

/** Non-empty identifier (project id, session id, worker id, card id...). */
export const idSchema = z.string().min(1);
export type Id = z.infer<typeof idSchema>;

/** GitHub issue or PR number (positive integer). */
export const refNumberSchema = z.number().int().positive();
export type RefNumber = z.infer<typeof refNumberSchema>;

// ---------------------------------------------------------------------------
// Kanban columns (agent-orchestrator pattern)
// ---------------------------------------------------------------------------

/** Board columns, in workflow order. */
export const KANBAN_COLUMNS = ["backlog", "in_progress", "in_review", "done"] as const;

export const kanbanColumnSchema = z.enum(KANBAN_COLUMNS);
export type KanbanColumn = (typeof KANBAN_COLUMNS)[number];

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

/** Per-project automation settings. */
export const projectSettingsSchema = z.object({
  /** GitHub username whose newly created/assigned issues auto-spawn workers. `null` disables auto-spawn. */
  autoAgentUsername: z.string().min(1).nullable(),
  /** Max concurrent workers for this project. */
  workerConcurrency: z.number().int().min(1).max(16).default(1),
});
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export type ProjectSettingsInput = z.input<typeof projectSettingsSchema>;

export const projectSchema = z.object({
  id: idSchema,
  /** Human-readable project name. */
  name: z.string().min(1),
  /** GitHub repository URL (https). */
  repoUrl: z.url(),
  defaultBranch: z.string().min(1),
  settings: projectSettingsSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Project = z.infer<typeof projectSchema>;

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export const issueStateSchema = z.enum(["open", "closed"]);

export const issueSchema = z.object({
  projectId: idSchema,
  /** GitHub issue number, unique per repository. */
  number: refNumberSchema,
  title: z.string().min(1),
  state: issueStateSchema,
  /** Issue number(s) this issue is natively "blocked by" on GitHub. */
  blockedBy: z.array(refNumberSchema),
  /** GitHub login of the assignee, if any. */
  assignee: z.string().min(1).nullable(),
  url: z.url(),
  updatedAt: isoDateTimeSchema,
});
export type Issue = z.infer<typeof issueSchema>;

// ---------------------------------------------------------------------------
// Pull request (GitHub only — no multi-forge abstraction)
// ---------------------------------------------------------------------------

export const pullRequestStateSchema = z.enum(["open", "merged", "closed"]);

/** Combined status of the PR's head commit checks. */
export const ciStatusSchema = z.enum(["pending", "running", "success", "failure", "unknown"]);

/** Latest review decision on the PR. */
export const reviewStateSchema = z.enum(["none", "pending", "approved", "changes_requested"]);

export const pullRequestSchema = z.object({
  projectId: idSchema,
  /** GitHub PR number, unique per repository. */
  number: refNumberSchema,
  title: z.string().min(1),
  state: pullRequestStateSchema,
  ciStatus: ciStatusSchema,
  reviewState: reviewStateSchema,
  headBranch: z.string().min(1),
  baseBranch: z.string().min(1),
  author: z.string().min(1),
  url: z.url(),
  updatedAt: isoDateTimeSchema,
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

// ---------------------------------------------------------------------------
// Kanban
// ---------------------------------------------------------------------------

export const cardKindSchema = z.enum(["issue", "pull_request"]);

export const kanbanCardSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  kind: cardKindSchema,
  /** Issue number (for `issue` cards) or PR number (for `pull_request` cards). */
  number: refNumberSchema,
  title: z.string().min(1),
  column: kanbanColumnSchema,
  /** Worker currently driving this card, if any. */
  workerId: idSchema.nullable(),
  updatedAt: isoDateTimeSchema,
});
export type KanbanCard = z.infer<typeof kanbanCardSchema>;

/** One column of a project board with its cards (ordered within the column). */
export const kanbanColumnSummarySchema = z.object({
  column: kanbanColumnSchema,
  cards: z.array(kanbanCardSchema),
});
export type KanbanColumnSummary = z.infer<typeof kanbanColumnSummarySchema>;

/** Full kanban state for a project. */
export const kanbanBoardSchema = z.object({
  projectId: idSchema,
  updatedAt: isoDateTimeSchema,
  /** All four columns, in `KANBAN_COLUMNS` order. */
  columns: z.array(kanbanColumnSummarySchema),
});
export type KanbanBoard = z.infer<typeof kanbanBoardSchema>;

// ---------------------------------------------------------------------------
// Session (tmux-backed terminal sessions)
// ---------------------------------------------------------------------------

export const sessionRoleSchema = z.enum(["orchestrator", "worker"]);

export const sessionSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  role: sessionRoleSchema,
  /** Name of the backing tmux session. */
  tmuxSession: z.string().min(1),
  /** Set when `role` is `"worker"` and the session belongs to a worker. */
  workerId: idSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type Session = z.infer<typeof sessionSchema>;

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/**
 * Worker lifecycle:
 * `spawning` → `running` → (`awaiting_ci` → `fixing_ci` | `addressing_review`)* → `done`
 * with `failed` / `stopped` as terminal failure states.
 */
export const workerStatusSchema = z.enum([
  "spawning",
  "running",
  "awaiting_ci",
  "fixing_ci",
  "addressing_review",
  "done",
  "failed",
  "stopped",
]);
export type WorkerStatus = z.infer<typeof workerStatusSchema>;

export const workerSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  /** Terminal session the worker's agent runs in. */
  sessionId: idSchema,
  /** Issue the worker was spawned for. */
  issueNumber: refNumberSchema,
  /** PR opened by the worker, once one exists. */
  prNumber: refNumberSchema.nullable(),
  status: workerStatusSchema,
  /** Short human-readable detail for the current status. */
  statusMessage: z.string().nullable(),
  startedAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Worker = z.infer<typeof workerSchema>;
