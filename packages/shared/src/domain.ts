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

/**
 * Agent-kind id (docs/agent-kinds.md): a kebab-case slug. Invariant: the
 * id is used both as a filename and as a tmux session/window-name segment,
 * so it must be tmux-safe — lowercase-only, no `_`. This is intentionally
 * stricter than {@link agentSkillIdSchema}; do not align the two.
 * Lives with the domain primitives (the session schema uses it); the
 * spec-v2 schema and the shipped kinds live in `agent-kind-spec.ts`.
 */
export const agentKindIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, "must be a kebab-case slug (lowercase letters, digits, `-`)");

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
  /**
   * Per-project overrides of the daemon-wide worker-pipeline toggles
   * (issue #106/#322). Unset/`null` = inherit the daemon-wide setting;
   * an explicit boolean overrides it for this project's PR loop only.
   * Read fresh on every pipeline decision, so a change lands without a
   * restart.
   */
  terminateOnMerge: z.boolean().nullish(),
  autoFixCi: z.boolean().nullish(),
  autoFixReviewComments: z.boolean().nullish(),
  autoReview: z.boolean().nullish(),
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
  /**
   * PR body (description), when the producer fetched it (issue #439): the
   * worker↔PR association scans it for issue references (`Closes #46`),
   * so a PR whose title/head branch does not name the issue is still
   * claimed deterministically. Optional: consumers must treat an absent
   * body as "no extra references".
   */
  body: z.string().optional(),
  /**
   * Whether GitHub reports the PR as conflicting with its base branch
   * (issue #322). Only the explicit-conflict producer sets it; `undefined`
   * (legacy payloads, GitHub still computing) means "not known to
   * conflict" — the auto review-agent gate treats that as passable.
   */
  mergeConflicts: z.boolean().optional(),
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


/**
 * The boot personas PiDeck ships (`agent/prompts/<persona>.md`) and shapes
 * panes for: the workspace-level global agent, per-project orchestrators,
 * workers (implementers and review agents alike), and the preset-prompt
 * agent kinds (docs/agent-kinds.md — a kind's persona file shares the
 * persona name). The one vocabulary for prompt overrides and skill
 * application: which persona's panes a user asset reaches.
 */
export const PERSONAS = ["global-agent", "orchestrator", "worker", "researcher", "devex-audit", "kiss-audit"] as const;
export const personaSchema = z.enum(PERSONAS);
export type Persona = z.infer<typeof personaSchema>;

/**
 * User-owned prompt override for one persona (issue #315): the rendered
 * boot prompt uses this content instead of the shipped
 * `agent/prompts/<persona>.md` default — which stays the fallback. Stored
 * in the daemon state dir (user-owned, update-safe); `{{PLACEHOLDER}}`
 * tokens keep working (unknown tokens stay verbatim). Absent override = the
 * shipped default runs.
 */
export const promptOverrideSchema = z.object({
  persona: personaSchema,
  content: z.string(),
  updatedAt: isoDateTimeSchema,
});
export type PromptOverride = z.infer<typeof promptOverrideSchema>;

/**
 * Slug-shaped asset id (skill). Invariant: filename safety only — the id
 * never appears in a tmux target, so unlike {@link agentKindIdSchema} it
 * may use uppercase and `_`.
 */
export const agentSkillIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "must be a slug (letters, digits, `-`, `_`)");

/**
 * One user-owned pi skill, single-file in v1 (issue #315, KISS): the content
 * is a complete skill markdown file (pi frontmatter with `name`/
 * `description` + body) deployed verbatim and surfaced to the personas'
 * panes via pi's `--skill <file>`. `personas` lists which persona panes get
 * it — empty means created but applied nowhere.
 */
export const agentSkillSchema = z.object({
  id: agentSkillIdSchema,
  content: z.string(),
  personas: z.array(personaSchema),
  updatedAt: isoDateTimeSchema,
});
export type AgentSkill = z.infer<typeof agentSkillSchema>;

/**
 * The full per-persona asset state served to the webapp (issue #315):
 * stored overrides/skills plus the shipped default prompt content per
 * persona (the editor's fallback text — the daemon resolves the shipped
 * `agent/prompts/*.md` files; the webapp has no repo access).
 */
export const agentAssetsSchema = z.object({
  prompts: z.array(promptOverrideSchema),
  skills: z.array(agentSkillSchema),
  defaults: z.record(personaSchema, z.string()),
});
export type AgentAssets = z.infer<typeof agentAssetsSchema>;

/** Body of `PUT /api/agent-assets/prompts/:persona`: the override content. */
export const savePromptOverrideRequestSchema = z.object({ content: z.string() });
export type SavePromptOverrideRequest = z.infer<typeof savePromptOverrideRequestSchema>;

/** Body of `PUT /api/agent-assets/skills/:skillId` (upsert): content + applied personas. */
export const saveAgentSkillRequestSchema = z.object({
  content: z.string(),
  personas: z.array(personaSchema),
});
export type SaveAgentSkillRequest = z.infer<typeof saveAgentSkillRequestSchema>;

// ---------------------------------------------------------------------------
// Shipped integration-level skills (issue #338 — shipped-default seed data)
// ---------------------------------------------------------------------------

export const shippedDefaultSkillSchema = z.object({
  /** Skill id — the `agent/skills/<name>/` directory (the pi skill `name`). */
  name: agentSkillIdSchema,
  /** Personas the skill ships applied to out of the box. */
  defaultPersonas: z.array(personaSchema).min(1),
});
export type ShippedDefaultSkill = z.infer<typeof shippedDefaultSkillSchema>;

/**
 * The shipped workflow skills (issue #338, extended by issue #463):
 * PiDeck-owned `agent/skills/<name>/` entries seeded into the agent-assets
 * store applied to their default personas out of the box (once per state
 * dir; afterwards ordinary, user-owned, per-persona configurable entries —
 * turn-off-able, re-appliable to other {@link Persona}s, deletable —
 * nothing is hardcoded always-on; issue #351 F2 wired the store to this
 * table). The skills' content is user-editable asset text.
 *
 * `using-pideck` (issue #463) is the CLI-catalog skill — it documents the
 * deterministic `pideck` commands every PiDeck agent may run — so it ships
 * applied to EVERY persona by default; the rest are orchestrator
 * workflow defaults. Removals are table edits (reversible), not content
 * deletions.
 */
export const SHIPPED_DEFAULT_SKILLS = [
  { name: "using-pideck", defaultPersonas: [...PERSONAS] },
  { name: "bash-triage", defaultPersonas: ["orchestrator"] },
  { name: "concept-brief", defaultPersonas: ["orchestrator"] },
  { name: "prd", defaultPersonas: ["orchestrator"] },
  { name: "spec-to-issues", defaultPersonas: ["orchestrator"] },
] as const satisfies readonly ShippedDefaultSkill[];

/** Ids of the shipped skills that are per-persona assignable (the store-seeded table above). */
export type ShippedDefaultSkillId = (typeof SHIPPED_DEFAULT_SKILLS)[number]["name"];

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
   * Agent kind (issues #297/#300/#302/#330, docs/agent-kinds.md): the kind
   * id of agent-kind sessions (shipped or user-defined); absent on plain
   * orchestrator/worker sessions. The kind fixes the persona and the
   * report route — see {@link AgentKindSpec.reportTarget}.
   */
  agentKind: agentKindIdSchema.optional(),
  /**
   * Parent session id (parent-of-any-role linkage, docs/agent-kinds.md §3):
   * a researcher's calling session, or the project orchestrator an
   * audit session reports to. Absent on top-level sessions.
   */
  parentSessionId: idSchema.optional(),
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
  /**
   * Runs-as-review-identity flag (issue #423): set when the pane was
   * launched with the review account's `GH_TOKEN` (issue #407) — the
   * second GitHub identity that can file real reviews on primary-account
   * PRs. Relaunch (#117) and reconcile-resurrect (#27) read the token
   * fresh from settings at recreation time and re-inject it, so a
   * resurrected reviewer never silently falls back to the primary
   * identity (whose decisive reviews get HTTP 422, degrading the review
   * leg to comment reviews the pipeline cannot key triggers on).
   */
  runsAsReviewIdentity: z.boolean().optional(),
  /**
   * Sidebar label (the spawn's `--name`, ≤ 20 characters). Optional:
   * producers that don't track it may omit it — consumers fall back to the
   * kind's label plus the tmux session name.
   */
  name: z.string().min(1).max(20).optional(),
  /** Set when `role` is `"worker"` and the session belongs to a worker. */
  workerId: idSchema.nullable(),
  createdAt: isoDateTimeSchema,
  /**
   * Archived-at timestamp (issue #357 B9): set when a persona agent
   * (agent-kind session) is terminated from the webapp — its registry
   * record is **kept** for history instead of hard-deleted (the worker
   * archive semantics, issue #64, applied to sessions), with the pane
   * scrollback captured alongside (the #104 pattern). Absent = live
   * session; archived sessions are excluded from live listings, relaunch,
   * and reconcile, and never resurrected.
   */
  archivedAt: isoDateTimeSchema.optional(),
});
export type Session = z.infer<typeof sessionSchema>;

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/**
 * Worker lifecycle (statuses are platform-derived, issue #411 — not
 * agent-reported):
 * `spawning` → `running` → (`awaiting_ci` → `fixing_ci` | `addressing_review`)* → `done`
 * with `failed` / `stopped` as terminal failure states.
 *
 * The transitions the PR pipeline owns follow platform-truth events: prompt
 * delivery sets `running` / `fixing_ci` / `addressing_review`; CI completion
 * moves a passively watching author out of `awaiting_ci` to `done` ("CI
 * green — awaiting review/merge") — `done` there is a resting state, and a
 * later CI failure or review findings deterministically wake the worker
 * again; the reviewer's own review submission ends its `running` round
 * (resting `awaiting_ci` until re-prompted). Prompt staleness (a timeout
 * heuristic, not truth) is the one remaining agent-behavior proxy. Manual
 * status updates from the webapp (#76) remain possible on top.
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
  /**
   * PRs associated with the worker (issue #470), oldest first — `prNumbers[0]`
   * is the canonical one (diffs, archived-log links). A worker may drive
   * several PRs (stacked/sibling branches under its `pideck/<workerId>`
   * namespace); the PR tracker holds one loop row per PR. Review agents
   * record the PR they review.
   */
  prNumbers: z.array(refNumberSchema),
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
   * `pideck spawn --issue/--prompt` input, an issue-spawn pipeline's issue
   * context (issue #266), or a review agent's review prompt. Optional for
   * backward compatibility: absent for pre-#120 records.
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

// ---------------------------------------------------------------------------
// Archived persona-agent session log (issue #357 B9)
// ---------------------------------------------------------------------------

/**
 * Read-only archived log for a terminated persona agent (issue #357 B9):
 * an agent-kind session terminated from the webapp is **archived**, not
 * deleted — the registry record is kept (with {@link Session.archivedAt})
 * and the tmux scrollback is captured at termination (the #104 pattern for
 * workers). Served by the shape-contracted route
 * `GET /api/sessions/:sessionId/log`.
 */
export const archivedAgentSessionLogSchema = z.object({
  /** The archived session's id. */
  sessionId: idSchema,
  projectId: idSchema,
  /** The persona kind (agent-kind sessions only). */
  agentKind: agentKindIdSchema,
  /** Sidebar label (`null` when the spawn did not record one). */
  name: z.string().min(1).max(20).nullable(),
  /** When the session was created. */
  createdAt: isoDateTimeSchema,
  /** When the persona agent was terminated. */
  archivedAt: isoDateTimeSchema,
  /**
   * When the scrollback was captured (termination time). `null` when the
   * pane was already gone at terminate time (nothing to capture).
   */
  capturedAt: isoDateTimeSchema.nullable(),
  /** Captured pane scrollback (plain text). Empty when nothing was captured. */
  scrollback: z.string(),
});
export type ArchivedAgentSessionLog = z.infer<typeof archivedAgentSessionLogSchema>;
