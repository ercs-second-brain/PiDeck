/**
 * Issue→auto-spawn pipeline (issue #10).
 *
 * Consumes the github issue watcher's events and turns eligible issues into
 * running workers:
 *
 * 1. **Filter** — only issues in a registered project with auto-spawn
 *    enabled (`settings.autoAgentUsername !== null`) are considered;
 *    `issue.created` qualifies directly, `issue.assigned` only when the
 *    issue is assigned to the configured auto-agent username.
 * 2. **Blocked check** — the native "blocked by" relationship links are
 *    resolved (closed and cross-repo blockers included in the detail) and
 *    filtered to **open** blockers client-side; any open blocker suppresses
 *    the spawn.
 * 3. **Dedupe** — at most one worker per project+issue, idempotent on
 *    event redelivery: an in-memory in-flight/succeeded map guards the
 *    pipeline lifetime, and non-terminal registry workers (surviving a
 *    daemon restart) are checked via the {@link WorkerSpawner} port.
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
 * 6. **Unblock sweep** (issue #408): a spawn suppressed by open blockers is
 *    recorded; {@link IssueSpawnPipeline.sweepUnblocked} re-evaluates those
 *    tickets when a PR merges in the project (its "Closes"-linked issues
 *    just closed), re-spawning the unblocked ones through the same matrix —
 *    deduped against running workers and gated by the #393 occupancy
 *    predicate when the project has a concurrency cap.
 *
 * No app wiring lives here: the daemon entry point owns constructing the
 * pipeline and piping watcher events into {@link IssueSpawnPipeline.handleEvent}.
 */

import { issueCardId, type GithubWatcherEvent, type Issue, type IssueBlocker, type KanbanCard, type KanbanUpdateEvent, type RefNumber } from "@pideck/shared";

import type { GhClient } from "../../github/gh.js";
import { GhBlockerResolver } from "./blockers.js";
import { Emitter } from "./emitter.js";
import { buildIssueSpawnPrompt } from "./prompts.js";
import {
  type BlockerResolver,
  type ProjectSource,
  type RegisteredProject,
  type WorkerSpawner,
} from "./ports.js";
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
   * Project occupancy (issue #393 — active workers + workerLike kind
   * sessions), the ONE shared predicate: the unblock sweep gates a capped
   * project's spawn on it so kind sessions block auto-spawns exactly like
   * every other spawn path. Optional; absent = the sweep relies on the
   * scheduler's worker-count accounting alone.
   */
  countOccupants?: (projectId: string) => number;
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
  private readonly now: () => Date;
  private readonly onError: (err: unknown) => void;

  /**
   * Issues this pipeline has accepted for spawn (in flight or already
   * spawned) — the redelivery idempotence guard. Entries are removed when
   * a spawn attempt fails so a redelivered event can retry.
   */
  private readonly accepted = new Set<string>();

  /**
   * Blocked tickets per project (issue #408): spawns suppressed by open
   * blockers, kept so the merge-driven unblock sweep can re-evaluate them
   * — the watcher emits no event when a blocker resolves, so without this
   * record the ticket would sit forever. In-memory by design: the sweep
   * re-derives the blocked state from GitHub, so losing the map on restart
   * only delays the next re-evaluation to the next redelivery/merge.
   */
  private readonly blocked = new Map<string, Map<number, Issue>>();

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
  }

  /**
   * Handles one watcher event. Synchronous: filtering and the dedupe mark
   * happen inline, the (potentially slow) blocked check + spawn run as a
   * scheduler task.
   */
  handleEvent(event: GithubWatcherEvent): void {
    if (event.type !== "issue.created" && event.type !== "issue.assigned") return;
    const issue = event.issue;
    const registered = this.projects.get(issue.projectId);
    if (registered === undefined) return; // not a registered project
    const username = registered.project.settings.autoAgentUsername;
    if (username === null) return; // auto-spawn disabled for this project
    if (event.type === "issue.assigned" && issue.assignee !== username) return;

    const key = issueKey(issue);
    if (this.accepted.has(key)) return; // already in flight / already spawned
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

  /** Whether this pipeline has the issue recorded as blocked (tests/ops). */
  isRecordedBlocked(projectId: string, issueNumber: RefNumber): boolean {
    return this.blocked.get(projectId)?.has(issueNumber) ?? false;
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
    const recorded = this.blocked.get(projectId);
    if (recorded === undefined || recorded.size === 0) return;
    const registered = this.projects.get(projectId);
    if (registered === undefined || registered.project.settings.autoAgentUsername === null) return;
    for (const [number, issue] of [...recorded]) {
      try {
        // A worker already runs this ticket (spawned elsewhere since it was
        // recorded): drop it — never conflict with a running worker.
        const active = await this.spawner.listActiveWorkerIssueNumbers(projectId);
        if (active.has(number)) {
          recorded.delete(number);
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
        recorded.delete(number);
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
    const perProject = this.blocked.get(issue.projectId) ?? new Map<number, Issue>();
    perProject.set(issue.number, issue);
    this.blocked.set(issue.projectId, perProject);
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

      const spawned = await this.spawner.spawnWorker(
        registered.project.id,
        issue.number,
        buildIssueSpawnPrompt(issue),
      );
      this.blocked.get(registered.project.id)?.delete(issue.number);
      this.emitCardMoved(registered.project.id, issue, spawned.worker.id);
    } catch (err) {
      this.accepted.delete(key);
      this.onError(err);
    }
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
