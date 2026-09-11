/**
 * Issue→worker-spawn pipeline, assignment-driven (issues #10, #416).
 *
 * Consumes the github issue watcher's events and turns assigned issues into
 * running workers. Assignment is the deterministic trigger (B36 #416): the
 * orchestrator assigns a GitHub user to an issue when it wants a worker —
 * **any** assignment (no per-user setting; the old `autoAgentUsername`
 * gate is gone) — and the assignment spawns the worker:
 *
 * 1. **Trigger** — `issue.assigned` events only; issue creation spawns
 *    nothing (an unassigned issue means no worker wanted yet).
 * 2. **Blocked check** — the native "blocked by" relationship links are
 *    resolved (closed and cross-repo blockers included in the detail) and
 *    filtered to **open** blockers client-side; any open blocker suppresses
 *    the spawn.
 * 3. **Dedupe** — at most one worker per project+issue, idempotent on
 *    event redelivery and re-assignment: an in-memory in-flight/succeeded
 *    map guards the pipeline lifetime, and non-terminal registry workers
 *    (surviving a daemon restart) are checked via the {@link WorkerSpawner}
 *    port.
 * 4. **Spawn** — through the {@link SpawnScheduler} and the
 *    {@link WorkerSpawner} port (default: `SessionManager.spawnWorker`).
 *    The default {@link QueueingScheduler} honors the project's
 *    `settings.workerConcurrency` cap: at most N workers per project, extras
 *    queueing FIFO as slots free; projects without a cap spawn immediately
 *    (default unbounded, #14). The spawn carries the issue context as the
 *    worker's initial prompt (issue #266) — a spawned worker never boots
 *    empty and idles.
 * 5. **Kanban** — on a successful spawn a shared-contract
 *    `kanban.card.moved` event (backlog → in_progress, full card attached)
 *    is emitted on {@link IssueSpawnPipeline.kanbanEvents} for the API
 *    layer (#9) to forward to connected webapps.
 * 6. **Retract** (issue #416) — `issue.unassigned` / `issue.closed` events
 *    cancel the lifecycle: queued spawn tasks are dropped (scheduler
 *    cancel), blocked records cleared, dedupe marks released, and any
 *    non-terminal worker for the issue is archived — unassign/close never
 *    leave zombie workers. Re-assigning later spawns a fresh worker.
 * 7. **Unblock sweep** (issue #408): a spawn suppressed by open blockers is
 *    recorded; {@link IssueSpawnPipeline.sweepUnblocked} re-evaluates those
 *    tickets when a PR merges in the project (its "Closes"-linked issues
 *    just closed), re-spawning the unblocked ones through the same matrix —
 *    deduped against running workers and gated by the #393 occupancy
 *    predicate when the project has a concurrency cap. The blocked map is
 *    persisted (issue #427, {@link BlockedTicketStore}): the watcher
 *    re-baselines on restart and the catch-up sweep never revisits issues
 *    at/below the cursor, so without persistence a restart would strand
 *    blocked tickets until a human re-assigned them.
 *
 * No app wiring lives here: the daemon entry point owns constructing the
 * pipeline and piping watcher events into {@link IssueSpawnPipeline.handleEvent}.
 */

import { issueCardId, type GithubWatcherEvent, type Issue, type IssueBlocker, type KanbanCard, type KanbanUpdateEvent, type RefNumber } from "@pideck/shared";

import type { GhClient } from "../../github/gh.js";
import type { WorkerPipelineSettings } from "../prs/settings.js";
import { resolvePipelineSettings } from "../prs/settings.js";
import { BlockedTicketStore } from "./blocked-store.js";
import { GhBlockerResolver } from "./blockers.js";
import { Emitter } from "./emitter.js";
import { buildIssueSpawnPrompt } from "./prompts.js";
import {
  type BlockerResolver,
  type ProjectSource,
  type RegisteredProject,
  type WorkerSpawner,
} from "./ports.js";
import type { ReusePolicy } from "./reuse.js";
import { QueueingScheduler, type SpawnScheduler } from "./scheduler.js";

export interface IssueSpawnPipelineOptions {
  /** Registered projects eligible for auto-spawn. */
  projects: ProjectSource;
  /** Native blocked-by resolution. Default: {@link GhBlockerResolver} over `gh`. */
  blockers?: BlockerResolver;
  /** Worker spawning. Default: {@link SessionManagerSpawner} over `sessions`. */
  spawner: WorkerSpawner;
  /** GhClient used by the default blocker resolver (required unless `blockers` is given). */
  gh?: GhClient;
  /** Spawn scheduling. Default: cap-aware {@link QueueingScheduler} (unbounded when the project sets no cap). */
  scheduler?: SpawnScheduler;
  /**
   * Persisted blocked-ticket map (issue #427). Default: an in-memory-only
   * store (no file) — the daemon wiring passes
   * `<stateDir>/blocked-tickets.json` so blocked tickets survive restarts.
   */
  blockedStore?: BlockedTicketStore;
  /**
   * Project occupancy (issue #393 — active workers + workerLike kind
   * sessions), the ONE shared predicate: the unblock sweep gates a capped
   * project's spawn on it so kind sessions block auto-spawns exactly like
   * every other spawn path. Optional; absent = the sweep relies on the
   * scheduler's worker-count accounting alone.
   */
  countOccupants?: (projectId: string) => number;
  /**
   * Idle-worker reuse (issue #471): consulted in the spawn path BEFORE a
   * fresh spawn, for every spawn source uniformly. A lane-carrying task
   * re-tasks an eligible `done` same-lane worker (pane alive, context
   * occupancy at/below the threshold, not stall-marked/failed); a task
   * with NO lane takes the deterministic fresh-spawn default. The lane
   * comes from spawn-request metadata via {@link laneFor} — assignment
   * events carry none today, so watcher-driven spawns always spawn fresh
   * (deliberate: no lane ⇒ no reuse).
   */
  reusePolicy?: ReusePolicy;
  /**
   * Worker-pipeline settings provider (issue #471): the reuse threshold is
   * resolved per project through {@link resolvePipelineSettings} — read
   * fresh on every reuse decision, so a settings change lands without a
   * restart. Required only when `reusePolicy` is set.
   */
  workerSettings?: () => WorkerPipelineSettings | undefined;
  /**
   * Per-spawn lane source (issue #471): returns the spawn request's
   * conceptual lane for the issue, or `undefined` for none. Default: no
   * lane — every watcher-driven spawn spawns fresh (deterministic
   * default). The manual spawn route (`pideck spawn --lane`) passes its
   * `--lane` through its own path.
   */
  laneFor?: (issue: Issue) => string | undefined;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Error sink for spawn/scheduling failures. Default: console.error. */
  onError?: (err: unknown) => void;
}

/** Pipeline-internal dedupe key: one worker per project+issue. */
function issueKey(issue: Issue): string {
  return `${issue.projectId}#${issue.number}`;
}

export class IssueSpawnPipeline {
  /**
   * Kanban update events (shared `KanbanUpdateEvent` contract). The API
   * layer subscribes here and forwards to connected websockets.
   */
  readonly kanbanEvents = new Emitter<KanbanUpdateEvent>();

  private readonly projects: ProjectSource;
  private readonly blockers: BlockerResolver;
  private readonly spawner: WorkerSpawner;
  private readonly scheduler: SpawnScheduler;
  private readonly countOccupants: ((projectId: string) => number) | undefined;
  private readonly reusePolicy: ReusePolicy | undefined;
  private readonly workerSettings: (() => WorkerPipelineSettings | undefined) | undefined;
  private readonly laneFor: ((issue: Issue) => string | undefined) | undefined;
  private readonly now: () => Date;
  private readonly onError: (err: unknown) => void;

  /**
   * Issues this pipeline has accepted for spawn (in flight or already
   * spawned) — the redelivery idempotence guard. Entries are removed when
   * a spawn attempt fails (retry) or the issue is retracted (#416: a later
   * assignment may spawn again).
   */
  private readonly accepted = new Set<string>();

  /**
   * Retracted issues per #416 (unassign/close observed while a spawn task
   * was queued or already running): the scheduler cannot cancel a started
   * task, so the spawn path re-checks this mark right before (and after)
   * spawning and archives instead. Cleared when the issue is assigned
   * again. In-memory by design — same restart semantics as `accepted`.
   */
  private readonly retracted = new Set<string>();

  /**
   * Blocked tickets per project (issue #408): spawns suppressed by open
   * blockers, kept so the merge-driven unblock sweep can re-evaluate them
   * — the watcher emits no event when a blocker resolves, so without this
   * record the ticket would sit forever. Persisted (issue #427): neither
   * the watcher's restart re-baseline nor the catch-up sweep (issues at/
   * below the cursor are never revisited) would ever re-trigger these
   * tickets, so the map survives restarts via {@link BlockedTicketStore}.
   */
  private readonly blockedStore: BlockedTicketStore;

  constructor(options: IssueSpawnPipelineOptions) {
    this.projects = options.projects;
    this.spawner = options.spawner;
    this.blockers = options.blockers ?? new GhBlockerResolver(options.gh as GhClient);
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? ((err) => console.error("[pideck/pipeline] issue pipeline error:", err));
    // Cap-aware by default: with no `workerConcurrency` set, queueing is
    // bypassed entirely and uncapped issues spawn immediately.
    this.scheduler =
      options.scheduler ?? new QueueingScheduler({ spawner: this.spawner, onError: (err) => this.onError(err) });
    this.countOccupants = options.countOccupants;
    this.reusePolicy = options.reusePolicy;
    this.workerSettings = options.workerSettings;
    this.laneFor = options.laneFor;
    this.blockedStore = options.blockedStore ?? new BlockedTicketStore();
  }

  /**
   * Handles one watcher event. Synchronous: filtering, the dedupe/retract
   * marks and the cancel happen inline, the (potentially slow) blocked
   * check + spawn run as a scheduler task.
   *
   * Assignment-driven (#416): `issue.assigned` spawns; `issue.created`
   * never does; `issue.unassigned` / `issue.closed` retract the issue's
   * spawn lifecycle (no queued spawn, no zombie worker).
   */
  handleEvent(event: GithubWatcherEvent): void {
    if (event.type === "issue.unassigned" || event.type === "issue.closed") {
      const issue = event.issue;
      if (this.projects.get(issue.projectId) === undefined) return; // not a registered project
      this.retract(issue, event.type === "issue.closed" ? "issue closed" : "issue unassigned");
      return;
    }
    if (event.type !== "issue.assigned") return; // issue.created spawns nothing (#416)
    const issue = event.issue;
    const registered = this.projects.get(issue.projectId);
    if (registered === undefined) return; // not a registered project

    const key = issueKey(issue);
    this.retracted.delete(key); // a fresh assignment overrides an earlier retract
    if (this.accepted.has(key)) return; // already in flight / already spawned: spawn once
    this.accepted.add(key);
    this.scheduler.schedule(
      () => this.spawnFor(registered, issue, key),
      {
        projectId: issue.projectId,
        issueNumber: issue.number,
        maxConcurrentWorkers: registered.project.settings.workerConcurrency ?? undefined,
      },
    );
  }

  /** Whether this pipeline has accepted the issue for spawn (dedupe view, tests/ops). */
  isAccepted(projectId: string, issueNumber: RefNumber): boolean {
    return this.accepted.has(`${projectId}#${issueNumber}`);
  }

  /** Whether the issue is currently retracted (unassigned/closed — tests/ops). */
  isRetracted(projectId: string, issueNumber: RefNumber): boolean {
    return this.retracted.has(`${projectId}#${issueNumber}`);
  }

  /** Whether this pipeline has the issue recorded as blocked (tests/ops). */
  isRecordedBlocked(projectId: string, issueNumber: RefNumber): boolean {
    return this.blockedStore.isRecorded(projectId, issueNumber);
  }

  /**
   * Merge-driven unblock sweep (issue #408, flow step 8): re-evaluates the
   * project's recorded blocked tickets. A merged PR's "Closes"-linked
   * issues are closed by GitHub at merge time, so the sweep re-resolves the
   * native blockers and re-schedules the tickets whose blockers all closed
   * — through the same spawn matrix as the watcher path (blocked check,
   * dedupe, cap queueing). Tickets that still have open blockers stay
   * recorded; tickets that gained a worker elsewhere are dropped.
   */
  async sweepUnblocked(projectId: string): Promise<void> {
    const recorded = this.blockedStore.snapshot(projectId);
    if (recorded === undefined || recorded.size === 0) return;
    const registered = this.projects.get(projectId);
    if (registered === undefined) return;
    for (const [number, issue] of [...recorded]) {
      try {
        // A worker already runs this ticket (spawned elsewhere since it was
        // recorded): drop it — never conflict with a running worker.
        const active = await this.spawner.listActiveWorkerIssueNumbers(projectId);
        if (active.has(number)) {
          this.blockedStore.remove(projectId, number);
          continue;
        }
        // Always re-resolve fresh here (the sweep's whole purpose): the
        // recorded snapshot's inline detail is stale by definition.
        const detail = await this.blockers.resolve(registered.repo, issue);
        const openBlockers = detail.filter((blocker) => blocker.state === "open");
        if (openBlockers.length > 0) {
          this.recordBlocked(issue); // still blocked (detail refreshed)
          continue;
        }
        // Unblocked: re-arm through the SAME spawn matrix. Occupancy gate
        // first (#393): at a capped project's occupancy limit the sweep
        // keeps the ticket recorded for the next sweep instead of spawning.
        const cap = registered.project.settings.workerConcurrency ?? undefined;
        if (cap !== undefined && (this.countOccupants?.(projectId) ?? 0) >= cap) continue;
        this.blockedStore.remove(projectId, number);
        const key = issueKey(issue);
        if (this.accepted.has(key)) continue;
        this.accepted.add(key);
        // The recorded snapshot's inline blocker detail is stale by
        // definition — strip it so spawnFor re-resolves fresh.
        const fresh: Issue = { ...issue, blockers: undefined };
        this.scheduler.schedule(
          () => this.spawnFor(registered, fresh, key),
          {
            projectId,
            issueNumber: issue.number,
            maxConcurrentWorkers: cap,
          },
        );
      } catch (err) {
        this.onError(err);
      }
    }
  }

  private recordBlocked(issue: Issue): void {
    this.blockedStore.record(issue);
  }

  /**
   * Retracts an issue's spawn lifecycle (issue #416): drops any queued
   * spawn task, clears the dedupe and blocked records (a later assignment
   * may spawn again), and archives any non-terminal worker for the issue —
   * unassign/close must not leave zombie workers. The retract mark guards
   * the cancel race with an in-flight spawn task (see {@link spawnFor}).
   */
  private retract(issue: Issue, reason: string): void {
    const key = issueKey(issue);
    this.retracted.add(key);
    this.accepted.delete(key);
    this.blockedStore.remove(issue.projectId, issue.number);
    this.scheduler.cancel(issue.projectId, issue.number);
    void this.spawner
      .archiveWorkersForIssue(issue.projectId, issue.number, `archived: ${reason} (#416)`)
      .catch((err: unknown) => this.onError(err));
  }

  private async spawnFor(registered: RegisteredProject, issue: Issue, key: string): Promise<void> {
    try {
      const openBlockers = await this.openBlockers(registered, issue);
      if (openBlockers.length > 0) {
        // Blocked: release the dedupe slot so a later redelivery (after the
        // blockers resolve) can spawn, and record the ticket for the merge-
        // driven unblock sweep (issue #408) — no watcher event fires when a
        // blocker resolves on its own.
        this.accepted.delete(key);
        this.recordBlocked(issue);
        return;
      }
      // Restart safety: a worker for this issue may already exist in the
      // registry from before a daemon restart.
      const active = await this.spawner.listActiveWorkerIssueNumbers(registered.project.id);
      if (active.has(issue.number)) return;

      // Issue #416: the issue may have been unassigned/closed while this
      // spawn task sat queued — never spawn for a retracted issue.
      if (this.retracted.has(key)) return;

      // Issue #471 — idle-worker reuse: consulted BEFORE a fresh spawn for
      // every spawn source uniformly. The lane is spawn-request metadata;
      // no lane ⇒ no reuse (the deterministic fresh-spawn default). The
      // threshold resolves per project, read fresh on every decision.
      const lane = this.laneFor?.(issue);
      if (lane !== undefined && this.reusePolicy !== undefined) {
        const threshold = resolvePipelineSettings(registered.project, this.workerSettings?.()).workerReuseContextThreshold;
        const reusable = await this.reusePolicy.findReusableWorker({
          projectId: registered.project.id,
          lane,
          thresholdPct: threshold,
        });
        if (reusable !== null) {
          const retasked = await this.spawner.retaskWorker(reusable.id, issue.number, buildIssueSpawnPrompt(issue));
          await this.settle(registered, issue, key, retasked.id);
          return;
        }
      }

      const spawned = await this.spawner.spawnWorker(
        registered.project.id,
        issue.number,
        buildIssueSpawnPrompt(issue),
        lane !== undefined ? { lane } : undefined,
      );
      await this.settle(registered, issue, key, spawned.worker.id);
    } catch (err) {
      this.accepted.delete(key);
      this.onError(err);
    }
  }

  /**
   * Settles an accepted spawn/retask (shared by the fresh-spawn and the
   * #471 reuse paths): the #416 retract may have been observed while the
   * spawn/retask was in flight — archive the just-started worker instead
   * of leaving it running (the retract path's own archive call ran before
   * this worker registered — exactly one of the two finds it); otherwise
   * clear the blocked record and emit the kanban card move.
   */
  private async settle(registered: RegisteredProject, issue: Issue, key: string, workerId: string): Promise<void> {
    if (this.retracted.has(key)) {
      await this.spawner.archiveWorkersForIssue(
        registered.project.id,
        issue.number,
        "archived: issue unassigned or closed (#416)",
      );
      return;
    }
    this.blockedStore.remove(registered.project.id, issue.number);
    this.emitCardMoved(registered.project.id, issue, workerId);
  }

  /**
   * Open blockers only: `Issue.blockedBy`/`Issue.blockers` detail may
   * include closed (and cross-repo) blockers; whether a blocker actually
   * blocks work is an open-state question, filtered client-side per the
   * shared contract docs.
   */
  private async openBlockers(registered: RegisteredProject, issue: Issue): Promise<IssueBlocker[]> {
    const detail = issue.blockers ?? (await this.blockers.resolve(registered.repo, issue));
    return detail.filter((blocker) => blocker.state === "open");
  }

  private emitCardMoved(projectId: string, issue: Issue, workerId: string): void {
    const at = this.now().toISOString();
    const card: KanbanCard = {
      id: issueCardId(projectId, issue.number),
      projectId,
      kind: "issue",
      number: issue.number,
      title: issue.title,
      column: "in_progress",
      workerId,
      updatedAt: at,
    };
    this.kanbanEvents.emit({
      type: "kanban.card.moved",
      at,
      projectId,
      cardId: card.id,
      from: "backlog",
      to: "in_progress",
      card,
    });
  }
}
