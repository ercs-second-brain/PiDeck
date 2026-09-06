/**
 * Spawn scheduling.
 *
 * Every spawn funnels through a {@link SpawnScheduler}. Two implementations:
 *
 * - {@link UnboundedScheduler} — starts each task immediately (the original
 *   default; kept for callers that want plain fire-and-forget).
 * - {@link QueueingScheduler} — honors a per-project concurrency cap
 *   (`Project.settings.workerConcurrency`, issue #14): at most N workers run
 *   concurrently per project; further tasks queue FIFO and start as slots
 *   free (a worker reaching a terminal state — done/failed/stopped — frees
 *   its slot). Issues whose project has **no cap spawn immediately**, so the
 *   default stays unbounded per #14's planning decision.
 *
 * Slot accounting combines two sources per project, keyed by issue number so
 * a task and the worker it spawned count as one slot:
 *
 * - the {@link WorkerSpawner.listActiveWorkerIssueNumbers} registry query
 *   (non-terminal workers — surviving daemon restarts), and
 * - spawn tasks started but not yet settled (a task occupies its issue's
 *   slot from start to settle, so the window between "task started" and
 *   "worker registered" cannot exceed the cap).
 *
 * While a project has queued tasks, a poll timer re-drains the queue so a
 * worker killed/stopped externally frees its slot without any event wiring.
 */

import type { WorkerSpawner } from "./ports.js";

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/** Per-spawn context cap-aware schedulers use for slot accounting. */
export interface SpawnRequest {
  projectId: string;
  issueNumber: number;
  /**
   * Max concurrent workers for the project. `undefined` = unbounded:
   * the task starts immediately.
   */
  maxConcurrentWorkers?: number;
}

export interface SpawnScheduler {
  /** Runs (or queues) one spawn task. Must not throw synchronously. */
  schedule(task: () => Promise<void>, request?: SpawnRequest): void;
}

// ---------------------------------------------------------------------------
// Unbounded (fire-and-forget)
// ---------------------------------------------------------------------------

export class UnboundedScheduler implements SpawnScheduler {
  constructor(private readonly onError: (err: unknown) => void = defaultOnError) {}

  schedule(task: () => Promise<void>, _request?: SpawnRequest): void {
    void task().catch((err: unknown) => this.onError(err));
  }
}

// ---------------------------------------------------------------------------
// Queueing (per-project concurrency cap)
// ---------------------------------------------------------------------------

/** Options for {@link QueueingScheduler}. */
export interface QueueingSchedulerOptions {
  /**
   * Non-terminal worker registry query, used to count running workers and to
   * notice slots freed by externally killed/stopped workers. Typically the
   * same {@link WorkerSpawner} the pipeline spawns through.
   */
  spawner: Pick<WorkerSpawner, "listActiveWorkerIssueNumbers">;
  /** Error sink for spawn task / drain failures. Default: console.error. */
  onError?: (err: unknown) => void;
  /**
   * How often (ms) queued tasks re-check for freed slots while queued.
   * Default 5s; `0` disables polling (slots then free only via task settle —
   * tests can drive `drain` manually or rely on settle-triggered drains).
   */
  pollIntervalMs?: number;
}

interface QueuedTask {
  task: () => Promise<void>;
  issueNumber: number;
  maxConcurrentWorkers: number;
}

export class QueueingScheduler implements SpawnScheduler {
  private readonly spawner: Pick<WorkerSpawner, "listActiveWorkerIssueNumbers">;
  private readonly onError: (err: unknown) => void;
  private readonly pollIntervalMs: number;

  /** FIFO of pending spawn tasks per project. */
  private readonly queues = new Map<string, QueuedTask[]>();
  /** Issue numbers whose spawn task started but has not settled, per project. */
  private readonly inFlight = new Map<string, Set<number>>();
  /** Serialized per-project drains — prevents concurrent drains over-spawning. */
  private readonly drains = new Map<string, Promise<void>>();
  /** Poll timers per project with queued tasks. */
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(options: QueueingSchedulerOptions) {
    this.spawner = options.spawner;
    this.onError = options.onError ?? defaultOnError;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
  }

  schedule(task: () => Promise<void>, request?: SpawnRequest): void {
    const cap = request?.maxConcurrentWorkers;
    if (request === undefined || cap === undefined) {
      // No cap for this project: default stays unbounded — spawn immediately.
      void task().catch((err: unknown) => this.onError(err));
      return;
    }
    const projectId = request.projectId;
    const queue = this.queues.get(projectId) ?? [];
    queue.push({ task, issueNumber: request.issueNumber, maxConcurrentWorkers: cap });
    this.queues.set(projectId, queue);
    this.ensurePoll(projectId);
    void this.drain(projectId);
  }

  /**
   * Attempts to start queued tasks for a project (FIFO) while slots are
   * free. Serialized per project; safe to call from anywhere (schedule,
   * task settle, poll tick).
   */
  drain(projectId: string): Promise<void> {
    const next = (this.drains.get(projectId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.drainLoop(projectId));
    this.drains.set(projectId, next);
    return next;
  }

  private async drainLoop(projectId: string): Promise<void> {
    for (;;) {
      const queue = this.queues.get(projectId);
      if (queue === undefined || queue.length === 0) {
        this.stopPoll(projectId);
        return;
      }
      const head = queue[0];
      if (head === undefined) {
        this.stopPoll(projectId);
        return;
      }
      let active: Set<number>;
      try {
        active = await this.spawner.listActiveWorkerIssueNumbers(projectId);
      } catch (err) {
        // Registry query failed: keep the queue, retry on the next poll tick
        // or task settle.
        this.onError(err);
        return;
      }
      const occupied = new Set<number>(active);
      const inFlight = this.inFlight.get(projectId);
      if (inFlight !== undefined) for (const issueNumber of inFlight) occupied.add(issueNumber);
      if (occupied.size >= head.maxConcurrentWorkers) return; // full; poll/settle re-drains
      queue.shift();
      this.startTask(projectId, head);
    }
  }

  private startTask(projectId: string, queued: QueuedTask): void {
    let inFlight = this.inFlight.get(projectId);
    if (inFlight === undefined) {
      inFlight = new Set<number>();
      this.inFlight.set(projectId, inFlight);
    }
    inFlight.add(queued.issueNumber);
    void (async () => {
      try {
        await queued.task();
      } catch (err) {
        this.onError(err);
      } finally {
        this.inFlight.get(projectId)?.delete(queued.issueNumber);
        // A no-op task (blocked / already-active issue) frees its slot here.
        void this.drain(projectId);
      }
    })();
  }

  private ensurePoll(projectId: string): void {
    if (this.pollIntervalMs <= 0 || this.timers.has(projectId)) return;
    const timer = setInterval(() => void this.drain(projectId), this.pollIntervalMs);
    timer.unref?.(); // never keep the daemon alive just for a poll tick
    this.timers.set(projectId, timer);
  }

  private stopPoll(projectId: string): void {
    const timer = this.timers.get(projectId);
    if (timer !== undefined) {
      clearInterval(timer);
      this.timers.delete(projectId);
    }
  }
}

function defaultOnError(err: unknown): void {
  console.error("[agentskiss/pipeline] spawn task failed:", err);
}
