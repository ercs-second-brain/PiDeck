/**
 * PR tracker: persisted registry of pull requests owned by platform
 * workers (issue #11).
 *
 * Each tracked PR records the association worker-session → PR (resolved
 * from the session registry's `worker.prNumbers` — one loop row per PR;
 * a worker may drive several PRs (issue #470)) plus the loop state
 * needed to drive and bound the CI-fix / review-addressing cycle:
 *
 * - `state`: `watching` (idle) → `fixing` | `addressing` (prompt sent,
 *   waiting for the worker to push) → back to `watching`; `done` /
 *   `failed` are terminal.
 * - `fixAttempts`: consecutive failed CI-fix prompts; reset whenever CI
 *   goes green. Bounded by the pipeline's `maxFixAttempts`.
 * - `lastPromptedHeadSha` / `lastPromptedAt`: distinguishes "worker still
 *   working on the previous prompt" from "worker pushed and CI failed
 *   again", and detects stuck prompts.
 * - `lastSeenCommentId`: watermark so review comments are delivered once,
 *   including comments that arrive after fixes.
 * - `reviewWorkerId` / `reviewedHeadSha`: the auto review agent (issue
 *   #107) currently assigned to the PR and the head SHA its latest round
 *   was spawned/re-prompted for. A new round starts whenever the head moves
 *   (or the previous reviewer died without deciding); the reviewer is
 *   archived when the PR is approved, merged, closed, or failed.
 * - `lastReviewSeenAt` (issue #407): watermark of the latest review
 *   submission observed on the PR (any state — approve, request changes,
 *   or comment). Each NEW submission is actionable exactly once: a new
 *   request-changes review deterministically prompts the PR-authoring
 *   worker to address the findings. #408's deterministic PR lifecycle keys
 *   further steps on this same signal.
 * - `readyNotifiedHeadSha` (issue #408): the head SHA the ready-for-merge
 *   notification last fired for (CI-green + approved + both agents idle). A
 *   new head or a new review round re-arms the trigger — each approved round
 *   notifies the orchestrator exactly once.
 * - `pendingReviewDecision` / `reviewFixAttempts` (issue #440): the
 *   changes-requested twin of the CI-fix cycle. A newly observed review
 *   decision requesting changes parks `pendingReviewDecision` — recorded on
 *   red polls too (the submission watermark consumes there), delivered by
 *   the decision branch once the author is idle on green, so the decision
 *   deterministically restarts the loop. `reviewFixAttempts` counts
 *   consecutive decision-prompted fix rounds (reset when the PR is
 *   approved); exhaustion stops driving the PR like the CI bound does.
 *
 * State is persisted to a JSON file (same pattern as the session
 * registry) so a daemon restart reconciles tracked PRs instead of losing
 * the loop (re-watch resilience).
 */

import { z } from "zod";

import { JsonStore } from "../../json-store.js";

const trackedPrStateSchema = z.enum(["watching", "fixing", "addressing", "done", "failed"]);

const trackedPRSchema = z.object({
  projectId: z.string().min(1),
  prNumber: z.number().int().positive(),
  headBranch: z.string().min(1),
  workerId: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string(),
  state: trackedPrStateSchema,
  fixAttempts: z.number().int().nonnegative(),
  lastPromptedAt: z.string().nullable(),
  lastPromptedHeadSha: z.string().nullable(),
  lastSeenCommentId: z.number().int().nullable(),
  /** Auto review agent (issue #107) assigned to this PR, if any. Defaults keep pre-#107 files loadable. */
  reviewWorkerId: z.string().nullable().default(null),
  /** Head SHA the reviewer's latest round was spawned/re-prompted for. */
  reviewedHeadSha: z.string().nullable().default(null),
  /** Latest review submission seen on the PR (issue #407 trigger watermark). Defaults keep pre-#407 files loadable. */
  lastReviewSeenAt: z.string().nullable().default(null),
  /** Head SHA the ready-for-merge notification last fired for (issue #408). Defaults keep pre-#408 files loadable. */
  readyNotifiedHeadSha: z.string().nullable().default(null),
  /** A newly observed changes-requested decision awaits its author prompt (issue #440). Defaults keep pre-#440 files loadable. */
  pendingReviewDecision: z.boolean().default(false),
  /** Consecutive changes-requested fix rounds driven (issue #440). Defaults keep pre-#440 files loadable. */
  reviewFixAttempts: z.number().int().nonnegative().default(0),
  headSha: z.string().nullable(),
  cardSignature: z.string().nullable(),
  updatedAt: z.string(),
});

export type TrackedPR = z.infer<typeof trackedPRSchema>;

const persistedStateSchema = z.object({
  version: z.literal(1),
  prs: z.array(trackedPRSchema),
});

interface PersistedState {
  version: 1;
  prs: TrackedPR[];
}

export interface RegisterTrackedPRInput {
  projectId: string;
  prNumber: number;
  headBranch: string;
  workerId: string;
  sessionId: string;
  title: string;
}

function trackingKey(projectId: string, prNumber: number): string {
  return `${projectId}#${prNumber}`;
}

export class PRTracker {
  private readonly prs = new Map<string, TrackedPR>();
  private readonly store: JsonStore<PersistedState>;

  constructor(filePath: string) {
    this.store = new JsonStore(filePath);
    this.load();
  }

  /** Registers a newly discovered worker-owned PR (no-op-safe via {@link get}). */
  register(input: RegisterTrackedPRInput, now = new Date()): TrackedPR {
    const tracked: TrackedPR = {
      ...input,
      state: "watching",
      fixAttempts: 0,
      lastPromptedAt: null,
      lastPromptedHeadSha: null,
      lastSeenCommentId: null,
      reviewWorkerId: null,
      reviewedHeadSha: null,
      lastReviewSeenAt: null,
      readyNotifiedHeadSha: null,
      pendingReviewDecision: false,
      reviewFixAttempts: 0,
      headSha: null,
      cardSignature: null,
      updatedAt: now.toISOString(),
    };
    this.prs.set(trackingKey(input.projectId, input.prNumber), tracked);
    this.save();
    return tracked;
  }

  get(projectId: string, prNumber: number): TrackedPR | undefined {
    return this.prs.get(trackingKey(projectId, prNumber));
  }

  list(): TrackedPR[] {
    return [...this.prs.values()];
  }

  /** PRs still being driven (terminal `done` / `failed` excluded). */
  listActive(): TrackedPR[] {
    return this.list().filter((pr) => pr.state !== "done" && pr.state !== "failed");
  }

  /** Writes current state to the JSON file (atomic via {@link JsonStore}). */
  save(): void {
    const state: PersistedState = { version: 1, prs: this.list() };
    this.store.save(state);
  }

  private load(): void {
    const state = this.store.load((value) => {
      const parsed = persistedStateSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    }, { version: 1, prs: [] });
    for (const pr of state.prs) {
      this.prs.set(trackingKey(pr.projectId, pr.prNumber), pr);
    }
  }
}
