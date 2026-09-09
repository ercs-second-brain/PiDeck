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

// ---------------------------------------------------------------------------
// Preset-prompt agent kinds (issues #297/#300/#302 — docs/agent-kinds.md)
// ---------------------------------------------------------------------------

/**
 * Preset-prompt agent kinds: sessions spawned with a pre-baked persona
 * prompt (`agent/prompts/<kind>.md`) and a fixed report route, instead of
 * a bespoke code path per kind. Deliberately distinct from
 * {@link workerKindSchema} (`implementer`/`reviewer`), which keeps its
 * meaning for PR-ownership semantics: a spawn is either a worker
 * (issue/PR-owned) or an agent-kind session (preset persona,
 * report-routed).
 */
export const AGENT_KINDS = ["researcher", "devex-audit", "kiss-audit"] as const;
export const agentKindSchema = z.enum(AGENT_KINDS);
export type AgentKind = z.infer<typeof agentKindSchema>;

/**
 * Body of the agent-kind spawn (docs/agent-kinds.md): the persona IS the
 * prompt, so a spawn carries the kind, a sidebar label, and — for
 * researchers — the question to research. `parentSessionId` is the
 * explicit parent-of-any-role; when omitted the daemon resolves the
 * calling pane and falls back to the project's orchestrator — the
 * caller-of-record for project-context spawns (issue #328).
 */
export const spawnAgentRequestSchema = z.object({
  kind: agentKindSchema,
  /** Sidebar label, <= 20 characters (pinned by the spawn-worker skill). */
  name: z.string().min(1).max(20),
  /** Question typed into the pane after launch (researcher input). */
  question: z.string().min(1).optional(),
/** Parent session of any role (docs/agent-kinds.md §3); resolved from the spawn context when omitted — the calling pane when one exists, else the project's orchestrator (issue #328). */
  parentSessionId: idSchema.optional(),
});
export type SpawnAgentRequest = z.infer<typeof spawnAgentRequestSchema>;

/**
 * Who receives an agent kind's final report (docs/agent-kinds.md §4).
 * The delivery mechanism is always `pideck send --session <id>`: kinds
 * with target `caller` deliver to `{{PARENT_SESSION_ID}}` (the calling
 * session), kinds with `project-orchestrator` deliver to
 * `{{ORCHESTRATOR_SESSION_ID}}`.
 */
export const AGENT_KIND_REPORT_TARGET = {
  researcher: "caller",
  "devex-audit": "project-orchestrator",
  "kiss-audit": "project-orchestrator",
} as const satisfies Record<AgentKind, "caller" | "project-orchestrator">;
export type AgentKindReportTarget = (typeof AGENT_KIND_REPORT_TARGET)[AgentKind];

/**
 * Per-kind presentation metadata (issue #324, deep audit #295 findings
 * 2-5): the shared source the web ⋯-menu buttons, the sidebar naming, and
 * the input rules render from. This makes docs/agent-kinds.md's "adding a
 * kind = registry row + persona file" claim true for the web too — no
 * per-kind edits outside this table. The enum guarantees coverage.
 */
export interface AgentKindInfo {
  /** Sidebar label — the spawn's default `--name` (the web renders "◇ <label>"). */
  label: string;
  /** The ⋯-menu button's display text ("Researcher"). */
  menuLabel: string;
  /** One-line behavior summary (the ⋯-menu buttons' title). */
  description: string;
  /**
   * Whether the kind takes free-text input (the researcher's question):
   * drives the web input modal, the CLI `--question` rules, and the spawn
   * schema's question refine.
   */
  takesInput: boolean;
}

export const AGENT_KIND_INFO: Record<AgentKind, AgentKindInfo> = {
  researcher: {
    label: "research",
    menuLabel: "Researcher",
    description: "Spawn a researcher — it researches one question against the codebase and reports back",
    takesInput: true,
  },
  "devex-audit": {
    label: "devex-audit",
    menuLabel: "Devex audit",
    description: "Spawn a devex audit — mines prior sessions for friction, reports to the orchestrator",
    takesInput: false,
  },
  "kiss-audit": {
    label: "kiss-audit",
    menuLabel: "KISS audit",
    description: "Spawn a KISS audit — complexity findings, reported to the orchestrator",
    takesInput: false,
  },
};

// ---------------------------------------------------------------------------
// Per-persona agent assets (issue #315): user-owned prompt overrides + skills
// ---------------------------------------------------------------------------

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

/** Slug-shaped asset id (skill): safe as a filename and a CLI-visible name. */
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
 * The shipped integration-level workflow skills (issue #338): PiDeck-owned
 * `agent/skills/<name>/` entries that are orchestrator defaults — applied
 * to the orchestrator persona out of the box. Seed data for #315's
 * agent-assets surface: it reads this table as the shipped-default
 * baseline, and every entry stays per-persona configurable there
 * (turn-off-able, re-appliable to other {@link Persona}s) — nothing is
 * hardcoded always-on. The skills' content is user-editable asset text.
 */
export const SHIPPED_DEFAULT_SKILLS = [
  { name: "bash-triage", defaultPersonas: ["orchestrator"] },
  { name: "concept-brief", defaultPersonas: ["orchestrator"] },
  { name: "prd", defaultPersonas: ["orchestrator"] },
  { name: "spec-to-issues", defaultPersonas: ["orchestrator"] },
] as const satisfies readonly ShippedDefaultSkill[];

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
   * Preset-prompt agent kind (issues #297/#300/#302, docs/agent-kinds.md):
   * set on agent-kind sessions (researcher / devex-audit / kiss-audit);
   * absent on plain orchestrator/worker sessions. The kind fixes the
   * persona and the report route — see {@link AGENT_KIND_REPORT_TARGET}.
   */
  agentKind: agentKindSchema.optional(),
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
   * Sidebar label (the spawn's `--name`, ≤ 20 characters). Optional:
   * producers that don't track it may omit it — consumers fall back to the
   * kind's label plus the tmux session name.
   */
  name: z.string().min(1).max(20).optional(),
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
