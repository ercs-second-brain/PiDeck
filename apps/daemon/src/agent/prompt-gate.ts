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
 *
 * One queue, one loop (issue #395): worker and session prompts share a
 * single `{sessionId, prompt, workerId?}` queue and a single delivery
 * pass — an entry with a `workerId` carries the worker status side
 * effects (terminal drop, `running` on success, `failed` on delivery
 * error); a session entry just drops loudly through the error sink.
 *
 * Prompt-gate v2 (issue #333) adds the spec-driven spawn decisions on top:
 * {@link planAgentKindSpawn} maps a kind spec to its post-boot delivery
 * (auto → taskTemplate, waitForInput → caller input or ready-idle) plus
 * the callerWaits completion notice, and the launch command's tool gating
 * reads the spec's `readOnly` flag — no hardcoded kind lists anywhere.
 */

import type { AgentKindSpec, Worker } from "@pideck/shared";

/** Worker statuses after which a queued prompt is meaningless. */
const TERMINAL_STATUSES = new Set(["done", "failed", "stopped", "archived"]);

/**
 * What a spawn of an agent-kind session delivers into the fresh pane after
 * the persona boot (prompt-gate v2, issue #333): the kind spec decides —
 * everything here reads the registry's spec, never a hardcoded kind list.
 *
 * - `auto` kinds get their `taskTemplate` (the #329 hook — the agent starts
 *   working unprompted; a caller input is not part of the contract and is
 *   rejected before the spawn by the route's 409 guard);
 * - `waitForInput` kinds sit ready (`none`) until the caller supplies input
 *   with the spawn — then the input is the delivery;
 */
type AgentKindSpawnDelivery =
  | { /** `waitForInput` without input — the pane sits ready for the caller. */
      kind: "none" }
  | { /** The caller's input for a `waitForInput` kind, typed after the boot. */
      kind: "caller-input"; text: string }
  | { /** The kind's `taskTemplate` for an `auto` kind (rendered by the spawn path). */
      kind: "task"; text: string };

/** The spec-driven spawn plan: pane delivery plus caller-completion notice. */
export interface AgentKindSpawnPlan {
  delivery: AgentKindSpawnDelivery;
  /**
   * Whether the calling pane should be told to expect the report (spec v2
   * `callerWaits`): only caller-routed kinds can expose completion to their
   * caller — an orchestrator-routed kind reports elsewhere, so there is
   * nothing for the caller to wait for.
   */
  notifyCaller: boolean;
}

/**
 * Plans a spawn's post-boot behavior from the kind spec (issue #333). Pure
 * and total over the config permutation (readOnly × trigger × callerWaits)
 * — the launch command consumes `readOnly` separately via
 * `agentKindExcludedTools`.
 */
export function planAgentKindSpawn(spec: AgentKindSpec, question: string | undefined): AgentKindSpawnPlan {
  const delivery: AgentKindSpawnDelivery =
    spec.trigger === "auto"
      ? spec.taskTemplate !== undefined
        ? { kind: "task", text: spec.taskTemplate }
        : { kind: "none" }
      : question !== undefined
        ? { kind: "caller-input", text: question }
        : { kind: "none" };
  return { delivery, notifyCaller: spec.callerWaits && spec.reportTarget === "caller" };
}

/**
 * The notice typed into a callerWaits kind's calling pane (issue #333): the
 * caller learns a report is coming to THIS session, so its flow can wait
 * instead of guessing — completion is exposed to the caller per the spec.
 */
export function callerWaitsNotice(spec: Pick<AgentKindSpec, "label">, name: string): string {
  return `[pideck] your ${spec.label} agent "${name}" is working; it will deliver its report to this session via pideck send — no polling needed.`;
}

/**
 * One queued prompt awaiting pi auth (issue #56, one queue per issue #395).
 * Worker spawns queue with a `workerId`; agent-kind sessions (the
 * researcher's question, docs/agent-kinds.md) queue without one. `prompt`
 * is `undefined` only for issue-backed worker spawns without an initial
 * prompt (the hold is about the truthful `spawning` status, not typing).
 */
interface PendingPrompt {
  sessionId: string;
  prompt: string | undefined;
  /** Present for worker spawns: the entry drives worker status transitions. */
  workerId?: string;
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

  /** Number of queued worker prompts (tests/observability). */
  get size(): number {
    return this.pending.filter((entry) => entry.workerId !== undefined).length;
  }

  /** Number of queued agent-kind session prompts (tests/observability). */
  get sessionSize(): number {
    return this.pending.filter((entry) => entry.workerId === undefined).length;
  }

  /**
   * Queues an agent-kind session's prompt after an unauthenticated spawn
   * (issue #56 parity for docs/agent-kinds.md spawns — the researcher's
   * question is never typed into an agent that cannot run). Idempotent per
   * session; retried by the same poll loop until deliverable.
   */
  queueSession(sessionId: string, prompt: string): void {
    if (this.pending.some((entry) => entry.workerId === undefined && entry.sessionId === sessionId)) return;
    this.pending.push({ sessionId, prompt });
    this.ensureTimer();
  }

  /**
   * One delivery pass over the queue (issue #395): for every entry, either
   * keep it waiting (auth not ready / worker still non-terminal), deliver
   * the prompt, or drop it truthfully. Worker entries drive worker status —
   * `running` on success, `failed` (never silently losing the prompt) when
   * the pane rejects the delivery, a silent drop when the worker already
   * ended. Session entries have no worker status, so a delivery failure
   * drops them loudly through the error sink (the pane is gone; the
   * question can never be answered). Safe to run concurrently — passes
   * serialize.
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
      const workerId = entry.workerId;
      // Worker branch: an ended worker's queued prompt is meaningless —
      // drop it before even probing readiness (session entries have no
      // worker to check and always take the readiness probe below).
      if (workerId !== undefined && this.endedWorker(workerId)) {
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
        this.onDelivered(entry, workerId);
        this.drop(entry);
      } catch (err) {
        this.onDeliveryFailed(entry, workerId, err);
      }
    }
    if (this.pending.length === 0) this.clearTimer();
  }

  /** True when a worker's queued prompt is meaningless (gone or ended). */
  private endedWorker(workerId: string): boolean {
    const worker = this.deps.getWorker(workerId);
    return worker === undefined || TERMINAL_STATUSES.has(worker.status);
  }

  /** Success hook: worker entries flip to `running` (sessions have none). */
  private onDelivered(entry: PendingPrompt, workerId: string | undefined): void {
    if (workerId === undefined) return;
    this.deps.updateWorkerStatus(
      workerId,
      "running",
      entry.prompt !== undefined ? "agent running; initial prompt delivered" : "agent running in tmux session",
    );
  }

  /**
   * Failure hook: the entry is always dropped. Worker entries record the
   * truth on the worker (`failed` — the prompt is never silently lost);
   * sessions have no worker status, so the failure surfaces loudly through
   * the error sink (the pane is gone; the question can never be answered).
   */
  private onDeliveryFailed(entry: PendingPrompt, workerId: string | undefined, err: unknown): void {
    this.drop(entry);
    if (workerId === undefined) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.deps.updateWorkerStatus(
      workerId,
      "failed",
      `initial prompt delivery failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  /** Stops the poll timer (daemon shutdown); queued entries stay inspectable. */
  stop(): void {
    this.clearTimer();
  }

  private drop(entry: PendingPrompt): void {
    const index = this.pending.indexOf(entry);
    if (index !== -1) this.pending.splice(index, 1);
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
