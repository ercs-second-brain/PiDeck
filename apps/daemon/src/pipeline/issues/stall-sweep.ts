/**
 * The issue-worker stall backstop (issue #467).
 *
 * An issue worker whose turn silently ends (`stopReason: "stop"`, no PR
 * yet — the observed session-179 failure mode) is re-prompted by nothing:
 * the PR loop only drives tracked PRs, the prompt gate handles queued
 * prompts only, and reconcile resurrects dead panes only. The worker idles
 * forever with uncommitted WIP while the board truthfully says `running`
 * (statuses are platform-derived; there is no agent-activity truth to
 * key on).
 *
 * {@link StallSweep} closes that hole with a deterministic sweep:
 *
 - **Eligible**: a non-terminal **issue** worker (`running`, issueNumber >
   0), no PR yet (the PR loop owns workers with PRs), no prompt in flight
   (the prompt gate holds nothing for it), and its record untouched for
   longer than {@link DEFAULT_STALL_THRESHOLD_MS} — the same staleness
   heuristic the PR loop's prompt timeout uses (prompt staleness is a
   timeout heuristic, not truth; see the shared Worker docblock).
 - **Bounded re-prompt**: each sweep re-prompts an eligible worker at most
   once, and at most {@link DEFAULT_MAX_STALL_RE_PROMPTS} times per worker
   (aligned with the PR loop's fix-attempt bound). Every re-prompt refreshes
   the worker's `updatedAt`, which re-arms the threshold — a re-prompted
   worker is not re-prompted again until it stalls again.
 - **Exhaustion**: once the bound is exhausted and the worker stalls again,
   a shared `notification.worker.stalled` event is emitted (once per
   worker, `notified` latch) and the sweep stops prompting. The pane stays
   alive for human/orchestrator follow-up — this only notifies.
 *
 * Per-worker sweep state is in-memory by design (same restart semantics as
 * the issue pipeline's dedupe map): a daemon restart resets the bound and
 * the sweep re-detects a still-stalled worker from its record freshness.
 *
 * Status semantics stay distinguishable for #471 (idle-with-capacity task
 * reuse): the sweep never changes the worker's status — a re-prompted
 * worker keeps `running` with a `stall backstop:` status message, and an
 * exhausted one keeps `running` with an explicit `stalled:` message.
 */

import { ACTIVE_WORKER_STATUSES, type NotificationEvent, type Worker, type WorkerStatus } from "@pideck/shared";

import { oneLine } from "../prompt-line.js";

/** Default age at which an issue worker's untouched record counts as stalled. */
export const DEFAULT_STALL_THRESHOLD_MS = 15 * 60_000;

/**
 * Default bound on stall re-prompts per worker, aligned with the PR loop's
 * fix-attempt cap (bounded like the bounded loops it complements).
 */
export const DEFAULT_MAX_STALL_RE_PROMPTS = 5;

/** The exhaustion notification the sweep emits (shared contract, issue #467). */
export type WorkerStalledEvent = Extract<NotificationEvent, { type: "notification.worker.stalled" }>;

/** The slice of the session facade / prompt gate the sweep consumes. */
export interface StallSweepDeps {
  /** The project's worker records (any status — the sweep filters). */
  listWorkers: (projectId: string) => Worker[];
  /** Whether the prompt gate holds a queued prompt for the worker (prompt in flight → not stalled). */
  hasPromptInFlight: (workerId: string) => boolean;
  /** Delivers the re-prompt line into the worker's pane (tmux sendKeys). */
  sendKeys: (sessionId: string, keys: string, options?: { enter?: boolean }) => Promise<void>;
  /** Worker status/message updates (kept truthful; see the module docblock). */
  updateWorkerStatus: (workerId: string, status: WorkerStatus, statusMessage?: string) => Worker;
  /** Idle age at which an issue worker counts as stalled. Default {@link DEFAULT_STALL_THRESHOLD_MS}. */
  stallThresholdMs?: number;
  /** Max stall re-prompts per worker before the exhaustion notification. Default {@link DEFAULT_MAX_STALL_RE_PROMPTS}. */
  maxRePrompts?: number;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Error sink for delivery failures (polling continues). Default: console.error. */
  onError?: (err: unknown) => void;
}

/** Per-worker sweep state: bounded re-prompt count + exhaustion latch. */
interface StallRecord {
  count: number;
  notified: boolean;
}

/**
 * Builds the stall backstop's re-prompt: a single pane-safe line (the
 * worker prompt conventions, `agent/prompts/worker.md` — it is typed into
 * an interactive pane followed by Enter) pointing the worker back at its
 * issue and the PR contract.
 */
export function buildStallRePromptPrompt(issueNumber: number): string {
  return oneLine(
    `[pideck] Stall backstop: your last turn ended without a PR for issue #${issueNumber}. ` +
      `Continue the task in your workspace (or resume your uncommitted WIP); when the change is ready, ` +
      `open the PR linking \`Closes #${issueNumber}\` in the body. If you are blocked, reply with the blocker.`,
  );
}

export class StallSweep {
  private readonly stallThresholdMs: number;
  private readonly maxRePrompts: number;
  private readonly now: () => Date;
  private readonly onError: (err: unknown) => void;
  private readonly listWorkers: (projectId: string) => Worker[];
  private readonly hasPromptInFlight: (workerId: string) => boolean;
  private readonly sendKeys: (sessionId: string, keys: string, options?: { enter?: boolean }) => Promise<void>;
  private readonly updateWorkerStatus: (workerId: string, status: WorkerStatus, statusMessage?: string) => Worker;
  /** workerId → sweep state. In-memory by design (module docblock). */
  private readonly state = new Map<string, StallRecord>();

  constructor(deps: StallSweepDeps) {
    this.listWorkers = deps.listWorkers;
    this.hasPromptInFlight = deps.hasPromptInFlight;
    this.sendKeys = deps.sendKeys;
    this.updateWorkerStatus = deps.updateWorkerStatus;
    this.stallThresholdMs = deps.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.maxRePrompts = deps.maxRePrompts ?? DEFAULT_MAX_STALL_RE_PROMPTS;
    this.now = deps.now ?? (() => new Date());
    this.onError = deps.onError ?? ((err) => console.error("[pideck/pipeline] stall sweep error:", err));
  }

  /**
   * One stall sweep over the project's workers. At most one bounded
   * re-prompt (or one exhaustion notification) per eligible worker per
   * call. Returns the exhaustion notifications emitted (the wiring
   * broadcasts them on the WS hub); send/status failures are sunk, never
   * thrown — the sweep is a background backstop.
   */
  async sweep(projectId: string): Promise<WorkerStalledEvent[]> {
    const workers = this.listWorkers(projectId);
    this.pruneState(workers);
    const events: WorkerStalledEvent[] = [];
    for (const worker of workers) {
      if (!this.isStalled(worker)) continue;
      const record = this.state.get(worker.id) ?? { count: 0, notified: false };
      this.state.set(worker.id, record);
      if (record.count >= this.maxRePrompts) {
        // Bound exhausted: notify once, never prompt again.
        if (!record.notified) {
          record.notified = true;
          this.updateWorkerStatus(
            worker.id,
            worker.status,
            `stalled: ${this.maxRePrompts} stall re-prompts exhausted without a PR for issue ` +
              `#${worker.issueNumber} — needs human/orchestrator attention (issue #467)`,
          );
          events.push({
            type: "notification.worker.stalled",
            at: this.now().toISOString(),
            projectId: worker.projectId,
            workerId: worker.id,
            issueNumber: worker.issueNumber,
            title: `issue #${worker.issueNumber} worker stalled: no PR after ${this.maxRePrompts} stall re-prompts`,
          });
        }
        continue;
      }
      try {
        await this.sendKeys(worker.sessionId, buildStallRePromptPrompt(worker.issueNumber), { enter: true });
      } catch (err) {
        this.onError(err); // delivery failed — the record stays fresh-less; the next sweep retries
        continue;
      }
      record.count += 1;
      this.updateWorkerStatus(
        worker.id,
        "running",
        `stall backstop: turn ended without a PR for issue #${worker.issueNumber} — re-prompted ` +
          `(${record.count}/${this.maxRePrompts}, issue #467)`,
      );
    }
    return events;
  }

  /** Whether this worker currently qualifies for a stall re-prompt or the exhaustion notification. */
  private isStalled(worker: Worker): boolean {
    if (!ACTIVE_WORKER_STATUSES.has(worker.status)) return false; // terminal workers are done
    if (worker.status === "spawning") return false; // the prompt gate owns spawning workers' prompts
    if (worker.kind === "reviewer") return false; // review agents are the PR-review cycle's domain (#441)
    if (worker.issueNumber <= 0) return false; // issue workers only (freeform workers have no issue to re-point at)
    if (worker.prNumber !== null) return false; // a worker with a PR is the PR loop's domain
    if (this.hasPromptInFlight(worker.id)) return false; // a held prompt is in flight — not stalled
    const at = Date.parse(worker.updatedAt);
    if (Number.isNaN(at)) return false;
    return this.now().getTime() - at > this.stallThresholdMs;
  }

  /**
   * Drops state for workers that are gone or no longer live non-terminal
   * issue workers without a PR (archived/failed since, PR opened — the PR
   * loop owns workers with PRs now): a later re-spawn of the same issue
   * starts with a fresh bound.
   */
  private pruneState(workers: Worker[]): void {
    const live = new Set(
      workers
        .filter((worker) => ACTIVE_WORKER_STATUSES.has(worker.status) && worker.issueNumber > 0 && worker.prNumber === null)
        .map((worker) => worker.id),
    );
    for (const workerId of [...this.state.keys()]) {
      if (!live.has(workerId)) this.state.delete(workerId);
    }
  }
}