/**
 * Spawn scheduling.
 *
 * The pipeline funnels every spawn through a {@link SpawnScheduler} so a
 * concurrency cap (#14) slots in as an alternative implementation — e.g. a
 * queueing scheduler that holds tasks while the project is at its
 * `settings.workerConcurrency` limit — without touching the pipeline.
 *
 * The default is unbounded: each accepted spawn task starts immediately.
 */

export interface SpawnScheduler {
  /** Runs (or queues) one spawn task. Must not throw synchronously. */
  schedule(task: () => Promise<void>): void;
}

export class UnboundedScheduler implements SpawnScheduler {
  constructor(private readonly onError: (err: unknown) => void = defaultOnError) {}

  schedule(task: () => Promise<void>): void {
    void task().catch((err: unknown) => this.onError(err));
  }
}

function defaultOnError(err: unknown): void {
  console.error("[agentskiss/pipeline] spawn task failed:", err);
}
