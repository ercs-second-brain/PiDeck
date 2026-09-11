/**
 * The issue-worker stall sweep (issue #467).
 *
 * An issue worker whose turn silently ends (pi stop, no PR yet — the
 * observed failure mode) is re-prompted by nothing: the PR loop only
 * drives tracked PRs, the prompt gate handles queued prompts only, and
 * `sessions/reconcile.ts` resurrects dead panes only. The worker idles
 * forever with uncommitted WIP. This sweep is the deterministic backstop:
 *
 * - **Criteria** (all must hold): an issue worker (`issueNumber > 0`, not
 *   a reviewer), non-terminal status other than `spawning` (a gate-held
 *   worker's prompt is in flight), **no PR**, and idle for the whole
 *   stall window (`worker.updatedAt` older than `stallIdleMs` — the record
 *   moves on every status transition and PR association, so a stale
 *   record + no PR means nothing platform-visible happened). A prompt
 *   queued on the prompt gate counts as in flight and skips the sweep.
 * - **Action**: one bounded re-prompt (`buildStallRepromptPrompt`) typed
 *   into the worker's pane, the worker bumped to `running` with a
 *   truthful `stalled … re-prompted (n/max)` status message (broadcast
 *   like any status change when wired through the automation's session
 *   control), the idle clock reset by the update.
 * - **Bound**: at most `maxReprompts` re-prompts per stall streak
 *   (default 2); the next sweep past exhaustion marks the worker `failed`
 *   with a manual-intervention message — terminal, visible on the board,
 *   pane left alive for WIP inspection. The streak resets only on
 *   progress: the worker delivers a PR, reaches a terminal status, or
 *   vanishes. The bookkeeping is in-memory (per daemon run) — a restart
 *   re-arms the clock, but the stall window still gates the first
 *   re-prompt, so a restart never prompt-spams.
 *
 * Status semantics vs idle-worker reuse (#471): the sweep acts only on
 * STALLED workers — non-terminal, no PR, no deliverable, idle past the
 * window — and marks exactly what it did in `statusMessage` (`stalled …`).
 * Reuse assigns NEW work to healthy idle workers; a stall-marked worker
 * (or one sitting in `failed` from exhaustion) is not idle capacity. A
 * worker that genuinely finished its issue turn shows the same pre-sweep
 * record as a stalled one — the re-prompt is what separates them (a
 * healthy-finished worker answers with a status and opens its PR).
 */

import { ACTIVE_WORKER_STATUSES, type Worker } from "@pideck/shared";

import type { SessionManager } from "../../sessions/manager.js";
import { isTerminalWorkerStatus } from "../../sessions/reconcile.js";
import { buildStallRepromptPrompt } from "./prompts.js";

/** Default idle window before a worker counts as stalled (issue #467). */
export const DEFAULT_STALL_IDLE_MS = 15 * 60_000;
/** Default bound on stall re-prompts per worker before it is failed. */
export const DEFAULT_MAX_REPROMPTS = 2;

/**
 * Wiring adapter (issue #467): builds the sweep over the automation's
 * pieces — the raw session facade (workers + pane sends), the broadcast-
 * wrapping session control for status changes, the prompt gate's in-flight
 * view, and the stall policy options. Keeps the automation constructor a
 * call, not a construction site.
 */
export function automationStallSweep(
  sessions: Pick<SessionManager, "listWorkers" | "sendKeys">,
  updateWorkerStatus: StallSweepDeps["updateWorkerStatus"],
  promptInFlight: (workerId: string) => boolean,
  options: { stallIdleMs?: number; maxReprompts?: number; now: () => Date; onError: (err: unknown, where: string) => void },
): StallSweep {
  return new StallSweep({
    listWorkers: () => sessions.listWorkers(),
    sendKeys: (sessionId, keys, sendOptions) => sessions.sendKeys(sessionId, keys, sendOptions),
    updateWorkerStatus: (workerId, status, statusMessage) => updateWorkerStatus(workerId, status, statusMessage),
    promptInFlight,
    ...(options.stallIdleMs !== undefined ? { stallIdleMs: options.stallIdleMs } : {}),
    ...(options.maxReprompts !== undefined ? { maxReprompts: options.maxReprompts } : {}),
    now: options.now,
    onError: (err) => options.onError(err, "stall-sweep"),
  });
}

/** Everything the sweep needs from the owning automation. */
export interface StallSweepDeps {
  /** All workers, every project (the sweep is daemon-wide). */
  listWorkers: () => Worker[];
  /** Types the re-prompt into the worker's pane. */
  sendKeys: (sessionId: string, keys: string, options?: { enter?: boolean }) => Promise<void>;
  /** Worker status updates (the wiring's broadcast-wrapping variant). */
  updateWorkerStatus: (workerId: string, status: Worker["status"], statusMessage?: string) => Worker;
  /**
   * Prompt-in-flight detection (issue #56 gate): a worker with a queued
   * prompt is already being driven — the sweep skips it. Optional; absent
   * = no gate (tests/legacy), the `spawning` status check still holds.
   */
  promptInFlight?: (workerId: string) => boolean;
  /** Idle window in ms. Default {@link DEFAULT_STALL_IDLE_MS}. */
  stallIdleMs?: number;
  /** Max re-prompts per stall streak. Default {@link DEFAULT_MAX_REPROMPTS}. */
  maxReprompts?: number;
  /** Injectable clock. */
  now: () => Date;
  /** Error sink (delivery failures already mark the worker; this logs). */
  onError: (err: unknown) => void;
}

/** One sweep pass's outcome (tests/observability). */
export interface StallSweepOutcome {
  /** Worker ids re-prompted this pass. */
  reprompted: string[];
  /** Worker ids marked failed this pass (bound exhausted or delivery died). */
  failed: string[];
}

export class StallSweep {
  private readonly listWorkers: () => Worker[];
  private readonly sendKeys: (sessionId: string, keys: string, options?: { enter?: boolean }) => Promise<void>;
  private readonly updateWorkerStatus: (workerId: string, status: Worker["status"], statusMessage?: string) => Worker;
  private readonly promptInFlight: (workerId: string) => boolean;
  private readonly stallIdleMs: number;
  private readonly maxReprompts: number;
  private readonly now: () => Date;
  private readonly onError: (err: unknown) => void;
  /**
   * Stall re-prompts so far, per worker id (in-memory, per daemon run).
   * The streak persists across sweeps — including the sweeps that skip the
   * worker because its clock has not run out again — and resets only on
   * progress (PR delivered, terminal status, worker gone).
   */
  private readonly attempts = new Map<string, number>();

  constructor(deps: StallSweepDeps) {
    this.listWorkers = deps.listWorkers;
    this.sendKeys = deps.sendKeys;
    this.updateWorkerStatus = deps.updateWorkerStatus;
    this.promptInFlight = deps.promptInFlight ?? (() => false);
    this.stallIdleMs = deps.stallIdleMs ?? DEFAULT_STALL_IDLE_MS;
    this.maxReprompts = deps.maxReprompts ?? DEFAULT_MAX_REPROMPTS;
    this.now = deps.now;
    this.onError = deps.onError;
  }

  /**
   * One sweep pass over every worker: re-prompts the stalled ones
   * (bounded), fails the exhausted ones. Never throws — one worker's
   * failure does not stop the sweep; errors go to the sink.
   */
  async sweep(): Promise<StallSweepOutcome> {
    const reprompted: string[] = [];
    const failed: string[] = [];
    const live = new Set<string>();
    for (const worker of this.listWorkers()) {
      live.add(worker.id);
      // Progress resets the streak: a worker that delivered a PR is the PR
      // loop's to drive, and a terminal one needs no backstop.
      if (worker.prNumber !== null || isTerminalWorkerStatus(worker.status)) {
        this.attempts.delete(worker.id);
        continue;
      }
      if (!isStallCandidate(worker, this.promptInFlight)) continue; // attempts kept (mid-cycle skip)
      if (this.now().getTime() - Date.parse(worker.updatedAt) < this.stallIdleMs) continue; // idle clock not up
      const attempt = (this.attempts.get(worker.id) ?? 0) + 1;
      if (attempt > this.maxReprompts) {
        this.attempts.delete(worker.id);
        try {
          this.updateWorkerStatus(
            worker.id,
            "failed",
            `stalled: ${this.maxReprompts} re-prompt(s) went unanswered — no PR, no activity (stall backstop exhausted, issue #467; manual intervention required)`,
          );
          failed.push(worker.id);
        } catch (err) {
          this.onError(err);
        }
        continue;
      }
      try {
        await this.sendKeys(worker.sessionId, buildStallRepromptPrompt(worker.issueNumber, attempt, this.maxReprompts), {
          enter: true,
        });
        // Status bump AFTER a successful send: the truthful record (and the
        // wiring's worker.status.changed broadcast) plus the idle clock reset.
        this.updateWorkerStatus(
          worker.id,
          "running",
          `stalled: turn ended without a PR — re-prompted (attempt ${attempt}/${this.maxReprompts})`,
        );
        this.attempts.set(worker.id, attempt);
        reprompted.push(worker.id);
      } catch (err) {
        // A failed delivery means the pane is gone: reconcile's rule applies
        // — the worker is failed, not stalled (never loop on a dead pane).
        this.attempts.delete(worker.id);
        try {
          this.updateWorkerStatus(
            worker.id,
            "failed",
            `stalled: stall re-prompt delivery failed (${err instanceof Error ? err.message : String(err)})`,
          );
          failed.push(worker.id);
        } catch (statusErr) {
          this.onError(statusErr);
        }
        this.onError(err);
      }
    }
    // Drop the streak bookkeeping for workers that vanished entirely
    // (deleted with their project, issue #172).
    for (const id of [...this.attempts.keys()]) {
      if (!live.has(id)) this.attempts.delete(id);
    }
    return { reprompted, failed };
  }
}

/**
 * Whether one worker is a stall candidate (issue #467): an issue worker
 * (freeform workers have `issueNumber 0`; review agents are a kind of
 * their own) in an active, non-spawning status with no PR and no prompt
 * queued on the gate. The idle-window check is the caller's (it owns the
 * clock); terminal and PR-owning workers never reach here.
 */
function isStallCandidate(worker: Worker, promptInFlight: (workerId: string) => boolean): boolean {
  if (worker.issueNumber <= 0) return false; // freeform workers have no issue lifecycle
  if (worker.kind === "reviewer") return false; // review agents settle via the PR loop (#441)
  if (!ACTIVE_WORKER_STATUSES.has(worker.status) || worker.status === "spawning") return false; // terminal or gate-held
  if (worker.prNumber !== null) return false; // the PR loop owns it
  return !promptInFlight(worker.id); // the prompt gate owns it
}
