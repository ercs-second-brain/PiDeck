import { z } from "zod";
import { PersonaSchema } from "./persona.js";
import { WorkerStateSchema } from "./state.js";

export const SessionSchema = z.object({
  id: z.string(),
  persona: PersonaSchema,
  projectId: z.string().nullable(),
  issueNumber: z.number().int().positive().optional(),
  prNumber: z.number().int().positive().optional(),
  tmuxSession: z.string(),
  spawnedAt: z.string(),
  model: z.string().nullable(),
  /** Optional user-given row name; shown instead of `#N title` in the sidebar. */
  label: z.string().optional(),
  archivedAt: z.string().optional(),
  lastPromptedHeadSha: z.string().nullable().default(null),
  lastDeliveredIssueCommentId: z.number().int().nullable().default(null),
  lastDeliveredPrCommentId: z.number().int().nullable().default(null),
  lastDeliveredReviewId: z.number().int().nullable().default(null),
  /** Head of the PR whose conflicts the worker was last told to resolve. */
  lastNotifiedConflictSha: z.string().nullable().default(null),
  fixAttempts: z.number().int().default(0),
  lastActivityAt: z.string().nullable().default(null),
});

export type Session = z.infer<typeof SessionSchema>;

export const SessionViewSchema = z.object({
  session: SessionSchema,
  state: WorkerStateSchema.nullable(),
  status: z.string(),
  parentSessionId: z.string().nullable(),
  /** The issue (or the issue behind the reviewer's PR) title, when known. */
  title: z.string().nullable(),
  /** Set when the review account cannot read the session's repo — no
   * reviewer runs while this is set. */
  reviewAccess: z.string().nullable().default(null),
});

export type SessionView = z.infer<typeof SessionViewSchema>;

/** Compact GitHub facts behind a trace entry — numbers, SHAs, CI, review decision, never bodies. */
export const TraceFactsSchema = z.object({
  issueNumber: z.number().int().optional(),
  openBlockers: z.number().int().optional(),
  prNumber: z.number().int().optional(),
  headSha: z.string().optional(),
  ci: z.string().optional(),
  failingChecks: z.array(z.string()).optional(),
  reviewDecision: z.string().nullable().optional(),
  mergeable: z.string().optional(),
});

export type TraceFacts = z.infer<typeof TraceFactsSchema>;

/** One line of the per-session trace: what the daemon saw and sent. */
export const TraceEntrySchema = z.object({
  at: z.string(),
  kind: z.enum(["delivery", "state", "spawn", "archive", "facts"]),
  /** delivery: the single line sent into the pane. */
  text: z.string().optional(),
  /** delivery: the watermark patch applied after the send succeeded. */
  watermark: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
  /** state: the previous and new worker state (null for non-workers). */
  from: WorkerStateSchema.nullable().optional(),
  to: WorkerStateSchema.nullable().optional(),
  /** state: the derived status line. */
  status: z.string().optional(),
  /** spawn/archive: what happened. */
  detail: z.string().optional(),
  /** facts: the compact GitHub facts that drove the tick. */
  facts: TraceFactsSchema.optional(),
});

export type TraceEntry = z.infer<typeof TraceEntrySchema>;

export const SessionTraceSchema = z.object({
  entries: z.array(TraceEntrySchema),
  /** The session's pi transcript JSONL, when it exists (live sessions only). */
  transcriptPath: z.string().nullable(),
});

export type SessionTrace = z.infer<typeof SessionTraceSchema>;
