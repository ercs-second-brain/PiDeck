/**
 * Domain model for PiDeck.
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

/** Non-empty identifier (project id, session id, worker id, card id...). */
export const idSchema = z.string().min(1);
export type Id = z.infer<typeof idSchema>;

/** GitHub issue or PR number (positive integer). */
export const refNumberSchema = z.number().int().positive();
export type RefNumber = z.infer<typeof refNumberSchema>;

// ---------------------------------------------------------------------------
// Global agent (workspace-level)
// ---------------------------------------------------------------------------

/**
 * Reserved pseudo-project id of the workspace-level global agent (the top
 * of the agent hierarchy: global agent → project orchestrators → workers →
 * review agents). The global agent is a regular orchestrator session under
 * this id — so registry persistence, reconcile/adoption, the terminal
 * bridge, relaunch, and `pideck send` all work unchanged — but it belongs
 * to no registered project (registration rejects the id) and its pane runs
 * in the daemon state dir root, the workspace spanning every project.
 */
export const GLOBAL_AGENT_PROJECT_ID = "global";

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
  /**
   * Max workers that may run concurrently for this project (issue #14).
   * Unset = unbounded: every unblocked issue spawns a worker immediately —
   * the default per #14's planning decision. With a cap, further unblocked
   * issues queue and spawn FIFO as slots free (a worker reaching a terminal
   * state — done/failed/stopped — frees its slot). `null` is accepted on
   * input and means the same as unset (issue #168: the settings UI sends
   * `null` explicitly to clear a cap; the service layer normalizes it to
   * unset, so a stored project never carries `null`).
   */
  workerConcurrency: z.number().int().min(1).max(16).nullish(),
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

const issueStateSchema = z.enum(["open", "closed"]);

/**
 * One native blocker of an issue, as reported by GitHub's GraphQL
 * `Issue.blockedBy` connection.
 *
 * Blocker semantics (verified against the live API — see issue #24):
 * - GraphQL `Issue.blockedBy` includes **closed** blockers; whether a
 *   blocker actually blocks work is an open-state question, so filtering
 *   to `state: "open"` is done **client-side**.
 * - Blockers may be **cross-repository**; `repository` carries the
 *   `owner/repo` of a foreign blocker and is `null` for same-repo ones.
 */
const issueBlockerSchema = z.object({
  /** Blocker issue number (unique per blocker repository). */
  number: refNumberSchema,
  state: issueStateSchema,
  /** `owner/repo` of the blocker's repository; `null` when same-repo. */
  repository: z.string().min(1).nullable(),
});
export type IssueBlocker = z.infer<typeof issueBlockerSchema>;

export const issueSchema = z.object({
  projectId: idSchema,
  /** GitHub issue number, unique per repository. */
  number: refNumberSchema,
  title: z.string().min(1),
  state: issueStateSchema,
  /**
   * Issue number(s) this issue is natively "blocked by" on GitHub.
   *
   * Same-repo **open** blockers only: GitHub's GraphQL `Issue.blockedBy`
   * includes closed (and cross-repo) blockers, so the open-state filter is
   * applied client-side when producing this field. Full detail — closed and
   * cross-repo blockers included — lives in {@link issueSchema `blockers`}.
   */
  blockedBy: z.array(refNumberSchema),
  /**
   * Optional full blocker detail mirroring GraphQL `Issue.blockedBy`,
   * including closed and cross-repo blockers ({@link IssueBlocker}).
   * Producers that only resolve open same-repo blockers may omit it;
   * consumers must not assume it is present.
   */
  blockers: z.array(issueBlockerSchema).optional(),
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
  /**
   * Lines added across the PR's diff, when the producer resolved diff totals
   * (kanban cards, issue #261). Optional: consumers must not assume it is
   * present, and event-derived cards may omit it until the next board fetch.
   */
  additions: z.number().int().nonnegative().optional(),
  /** Lines deleted across the PR's diff — see {@link pullRequestSchema `additions`}. */
  deletions: z.number().int().nonnegative().optional(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

// ---------------------------------------------------------------------------
// Kanban
// ---------------------------------------------------------------------------

const cardKindSchema = z.enum(["issue", "pull_request"]);

/** Stable kanban card id for an issue card (derived once, shared by the daemon's API + pipelines). */
export function issueCardId(projectId: string, number: RefNumber): string {
  return `issue-${projectId}-${number}`;
}

/** Stable kanban card id for a tracked PR (stable across restarts). */
export function prCardId(projectId: string, prNumber: number): string {
  return `pr:${projectId}:${prNumber}`;
}

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
  /**
   * GitHub URL of the underlying issue/PR (issue #261), when the producer
   * resolved it. Optional: event-derived cards may omit it, and consumers
   * must render the title as plain text when absent.
   */
  url: z.url().optional(),
  /** Lines added by the PR's diff — PR cards only, when known (issue #261). */
  additions: z.number().int().nonnegative().optional(),
  /** Lines deleted by the PR's diff — see {@link kanbanCardSchema `additions`}. */
  deletions: z.number().int().nonnegative().optional(),
});
export type KanbanCard = z.infer<typeof kanbanCardSchema>;

/** One column of a project board with its cards (ordered within the column). */
const kanbanColumnSummarySchema = z.object({
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

const sessionRoleSchema = z.enum(["orchestrator", "worker"]);
/** Role of a tmux-backed session (parity with `WorkerStatus`). */
export type SessionRole = z.infer<typeof sessionRoleSchema>;

export const sessionSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  role: sessionRoleSchema,
  /** Name of the backing tmux session. */
  tmuxSession: z.string().min(1),
  /**
   * Working directory the session's pane was launched in (project clone or
   * worktree path). Optional: producers that don't track it may omit it.
   */
  cwd: z.string().min(1).optional(),
  /**
   * Command the session's pane was launched with (e.g. `pi`). Optional:
   * producers that don't track it may omit it.
   */
  command: z.string().min(1).optional(),
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
 *
 * `archived` is a terminal status set only by an explicit terminate (issue
 * #64): the worker's tmux session was killed from the webapp and its
 * registry record is kept for history. Archived workers are never
 * resurrected by reconcile and never count as active.
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
  "archived",
]);
export type WorkerStatus = z.infer<typeof workerStatusSchema>;

/**
 * What a worker does (issue #107): `implementer` owns the issue/PR build
 * loop (the default — records may omit the field, older ones always do);
 * `reviewer` is an auto-spawned code-review agent that reviews a PR and
 * posts a GitHub review, nested under the PR-authoring worker via
 * {@link Worker.parentWorkerId}.
 */
export const workerKindSchema = z.enum(["implementer", "reviewer"]);
export type WorkerKind = z.infer<typeof workerKindSchema>;

/**
 * Worker statuses that count as "actively working" (non-terminal): spawning,
 * running, and the CI/review loop states. The single source of truth for
 * concurrency caps, spawn dedupe, and pipeline ownership checks. Terminal
 * statuses are the complement: `done` / `failed` / `stopped` / `archived`.
 * Issue #76 reuses the same list as the click-to-update gate; orchestrator
 * sessions are not workers and never count as active.
 */
export const ACTIVE_WORKER_STATUSES: ReadonlySet<WorkerStatus> = new Set([
  "spawning",
  "running",
  "awaiting_ci",
  "fixing_ci",
  "addressing_review",
] as const);

export const workerSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  /** Terminal session the worker's agent runs in. */
  sessionId: idSchema,
  /**
   * Issue the worker was spawned for. `0` marks a **freeform worker** —
   * spawned from a plain task prompt (`pideck spawn --prompt ...`)
   * with no backing GitHub issue; freeform workers have no issue/kanban
   * card of their own and only ever appear in the workers list.
   */
  issueNumber: z.number().int().min(0),
  /** PR opened by the worker, once one exists. Review agents record the PR they review. */
  prNumber: refNumberSchema.nullable(),
  /**
   * What the worker does ({@link workerKindSchema}). Optional for backward
   * compatibility: absent means `"implementer"` (all pre-#107 records).
   */
  kind: workerKindSchema.optional(),
  /**
   * Worker this one is nested under (issue #107): review agents carry the
   * PR-authoring worker's id when the PR→worker association is known,
   * `null`/absent for sibling spawns and all implementer workers.
   */
  parentWorkerId: idSchema.nullable().optional(),
  /**
   * Initial prompt typed into the worker's pane at spawn (issue #120): the
   * `pideck spawn --issue/--prompt` input, or a review agent's review
   * prompt. Optional for backward compatibility: absent for pre-#120
   * records and auto-spawned workers (which are typed no prompt at spawn).
   */
  prompt: z.string().min(1).optional(),
  /**
   * Filesystem path the worker's agent runs in — the project clone or a
   * per-issue worktree (e.g. under `<stateDir>/projects/<projectId>/worktrees/`).
   * Optional: producers that derive location from project layout may omit it.
   */
  worktreePath: z.string().min(1).optional(),
  status: workerStatusSchema,
  /** Short human-readable detail for the current status. */
  statusMessage: z.string().nullable(),
  startedAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Worker = z.infer<typeof workerSchema>;

// ---------------------------------------------------------------------------
// Archived worker session log (issue #104)
// ---------------------------------------------------------------------------

/**
 * Read-only archived session log for a terminated worker (issue #104): the
 * tmux scrollback captured when the pane was killed plus the worker's final
 * metadata. Served by `GET /api/workers/:workerId/log`.
 */
export const archivedWorkerLogSchema = z.object({
  workerId: idSchema,
  projectId: idSchema,
  /** Task the worker ran (`0` = freeform prompt worker). */
  issueNumber: z.number().int().min(0),
  /** PR the worker had opened, if any. */
  prNumber: refNumberSchema.nullable(),
  /** Initial prompt the worker was spawned with (`null` when not recorded — pre-#120 workers). */
  prompt: z.string().nullable(),
  finalStatus: workerStatusSchema,
  /** Last status message at termination. */
  finalStatusMessage: z.string().nullable(),
  startedAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  /**
   * When the scrollback was captured (termination time). `null` for workers
   * archived before capture existed, or when the pane was already gone at
   * terminate time.
   */
  capturedAt: isoDateTimeSchema.nullable(),
  /** Captured pane scrollback (plain text). Empty when nothing was captured. */
  scrollback: z.string(),
});
export type ArchivedWorkerLog = z.infer<typeof archivedWorkerLogSchema>;
