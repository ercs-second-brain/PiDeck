/**
 * Initial-prompt readiness gate (issue #56).
 *
 * Worker spawns used to type the initial task prompt into the fresh tmux
 * pane immediately after launch — even when the pi coding agent had no
 * usable credentials, so the prompt was swallowed by an unauthenticated or
 * dead pane while the worker happily reported `running`.
 *
 * {@link PromptGate} closes that hole:
 *
 * - spawns whose pi auth is **not** ready never get their prompt typed;
 *   the worker stays at the truthful `spawning` status with a precise
 *   `statusMessage` (what is wrong and how to fix it) and the prompt is
 *   queued here;
 * - a poll loop re-checks pi readiness; once ready the queued prompt is
 *   delivered into the pane and the worker moves to `running`. Workers that
 *   reached a terminal state (done/failed/stopped) while queued are dropped,
 *   and a delivery failure (e.g. the pane died) marks the worker `failed` —
 *   the prompt is never silently lost.
 *
 * Spawns with no initial prompt (issue-backed auto-spawns) are also held at
 * `spawning` until auth is ready, so the board never shows an
 * unauthenticated worker as `running` (issue #56).
 *
 * Agent-kind sessions (docs/agent-kinds.md) share the same gate via
 * {@link queueSession}: their prompts (the researcher's question) are
 * queued until pi auth is ready and retried by the same loop — sessions
 * have no worker status, so a delivery failure drops the entry loudly
 * (the pane is gone; the question can never be answered).
 */

import type { Worker } from "@pideck/shared";

/** Worker statuses after which a queued prompt is meaningless. */
const TERMINAL_STATUSES = new Set(["done", "failed", "stopped", "archived"]);

interface PendingPrompt {
  workerId: string;
  sessionId: string;
  /** Initial task prompt, `undefined` for issue-backed spawns without one. */
  prompt: string | undefined;
}

/** A queued prompt for an agent-kind session (docs/agent-kinds.md) — e.g. the
 * researcher's question — held until pi auth is ready (issue #56 parity).
 * Sessions have no worker status, so these retry until deliverable. */
interface PendingSessionPrompt {
  sessionId: string;
  prompt: string;
}

export interface PromptGateDeps {
  sendKeys: (sessionId: string, keys: string, options?: { enter?: boolean }) => Promise<void>;
  getWorker: (workerId: string) => Worker | undefined;
  updateWorkerStatus: (workerId: string, status: Worker["status"], statusMessage?: string) => Worker;
  /** Pi-auth readiness (issue #57 probe). */
  isReady: () => Promise<boolean>;
  /**
   * Re-check interval in ms while prompts are queued. Default 5_000;
   * `0` disables the timer (tests drive {@link deliverPending} manually).
   */
  pollIntervalMs?: number;
  /** Error sink for background delivery failures. Default: console.error. */
  onError?: (err: unknown) => void;
}

export class PromptGate {
  private readonly deps: Pick<PromptGateDeps, "sendKeys" | "getWorker" | "updateWorkerStatus" | "isReady">;
  private readonly pollIntervalMs: number;
  private readonly onError: (err: unknown) => void;

  private readonly pending: PendingPrompt[] = [];
  private readonly pendingSessions: PendingSessionPrompt[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private delivering: Promise<void> | null = null;

  constructor(deps: PromptGateDeps) {
    this.deps = deps;
    this.pollIntervalMs = deps.pollIntervalMs ?? 5_000;
    this.onError = deps.onError ?? ((err) => console.error("[daemon] prompt-gate delivery failed:", err));
  }

  /**
   * Queues a worker's initial prompt after an unauthenticated spawn and
   * flips the worker to the truthful held status. Idempotent per worker.
   */
  queue(worker: Worker, prompt: string | undefined): void {
    if (this.pending.some((entry) => entry.workerId === worker.id)) return;
    this.pending.push({ workerId: worker.id, sessionId: worker.sessionId, prompt });
    this.deps.updateWorkerStatus(
      worker.id,
      "spawning",
      prompt !== undefined
        ? "waiting for pi auth: no ready provider (run \"pideck onboard\" or launch pi and use /login on the daemon host); initial prompt queued"
        : 'waiting for pi auth: no ready provider (run "pideck onboard" or launch pi and use /login on the daemon host)',
    );
    this.ensureTimer();
  }

  /** Number of queued prompts (tests/observability). */
  get size(): number {
    return this.pending.length;
  }

  /** Number of queued agent-kind session prompts (tests/observability). */
  get sessionSize(): number {
    return this.pendingSessions.length;
  }

  /**
   * Queues an agent-kind session's prompt after an unauthenticated spawn
   * (issue #56 parity for docs/agent-kinds.md spawns — the researcher's
   * question is never typed into an agent that cannot run). Idempotent per
   * session; retried by the same poll loop until deliverable.
   */
  queueSession(sessionId: string, prompt: string): void {
    if (this.pendingSessions.some((entry) => entry.sessionId === sessionId)) return;
    this.pendingSessions.push({ sessionId, prompt });
    this.ensureTimer();
  }

  /**
   * One delivery pass over the queue: for every entry, either keep it
   * waiting (auth not ready / worker still non-terminal), deliver the prompt
   * and mark the worker `running`, or drop it truthfully (`failed` when the
   * pane rejects the delivery, silently when the worker already ended).
   * Safe to run concurrently — passes serialize.
   */
  async deliverPending(): Promise<void> {
    if (this.delivering !== null) return this.delivering;
    this.delivering = this.deliverAll().finally(() => {
      this.delivering = null;
    });
    return this.delivering;
  }

  private async deliverAll(): Promise<void> {
    for (const entry of [...this.pending]) {
      const worker = this.deps.getWorker(entry.workerId);
      if (worker === undefined || TERMINAL_STATUSES.has(worker.status)) {
        this.drop(entry);
        continue;
      }
      let ready: boolean;
      try {
        ready = await this.deps.isReady();
      } catch (err) {
        this.onError(err);
        continue;
      }
      if (!ready) continue;
      try {
        if (entry.prompt !== undefined) {
          await this.deps.sendKeys(entry.sessionId, entry.prompt, { enter: true });
        }
        this.deps.updateWorkerStatus(
          entry.workerId,
          "running",
          entry.prompt !== undefined ? "agent running; initial prompt delivered" : "agent running in tmux session",
        );
        this.drop(entry);
      } catch (err) {
        this.deps.updateWorkerStatus(
          entry.workerId,
          "failed",
          `initial prompt delivery failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.drop(entry);
      }
    }
    await this.deliverSessionPrompts();
    if (this.pending.length === 0 && this.pendingSessions.length === 0) this.clearTimer();
  }

  /**
   * One delivery pass over the agent-kind session queue (docs/agent-kinds.md):
   * keep waiting while auth is unready, deliver once it is, and drop loudly
   * when the pane rejects the delivery (the question can never be answered).
   */
  private async deliverSessionPrompts(): Promise<void> {
    for (const entry of [...this.pendingSessions]) {
      let ready: boolean;
      try {
        ready = await this.deps.isReady();
      } catch (err) {
        this.onError(err);
        continue;
      }
      if (!ready) continue;
      try {
        await this.deps.sendKeys(entry.sessionId, entry.prompt, { enter: true });
        this.dropSession(entry);
      } catch (err) {
        this.dropSession(entry);
        this.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /** Stops the poll timer (daemon shutdown); queued entries stay inspectable. */
  stop(): void {
    this.clearTimer();
  }

  private drop(entry: PendingPrompt): void {
    const index = this.pending.indexOf(entry);
    if (index !== -1) this.pending.splice(index, 1);
  }

  private dropSession(entry: PendingSessionPrompt): void {
    const index = this.pendingSessions.indexOf(entry);
    if (index !== -1) this.pendingSessions.splice(index, 1);
  }

  private ensureTimer(): void {
    if (this.timer !== null || this.pollIntervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.deliverPending().catch((err: unknown) => this.onError(err));
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
