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
 *    (default unbounded, #14).
 * 5. **Kanban** — on a successful spawn a shared-contract
 *    `kanban.card.moved` event (backlog → in_progress, full card attached)
 *    is emitted on {@link IssueSpawnPipeline.kanbanEvents} for the API
 *    layer (#9) to forward to connected webapps.
 *
 * No app wiring lives here: the daemon entry point owns constructing the
 * pipeline and piping watcher events into {@link IssueSpawnPipeline.handleEvent}.
 */

import type { GithubWatcherEvent, Issue, IssueBlocker, KanbanCard, KanbanUpdateEvent, RefNumber } from "@agentskiss/shared";

import type { GhClient } from "../../github/gh.js";
import { GhBlockerResolver } from "./blockers.js";
import { Emitter } from "./emitter.js";
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
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Error sink for spawn/scheduling failures. Default: console.error. */
  onError?: (err: unknown) => void;
}

/** Stable kanban card id for an issue card. */
export function issueCardId(projectId: string, number: RefNumber): string {
  return `issue-${projectId}-${number}`;
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
  private readonly now: () => Date;
  private readonly onError: (err: unknown) => void;

  /**
   * Issues this pipeline has accepted for spawn (in flight or already
   * spawned) — the redelivery idempotence guard. Entries are removed when
   * a spawn attempt fails so a redelivered event can retry.
   */
  private readonly accepted = new Set<string>();

  constructor(options: IssueSpawnPipelineOptions) {
    this.projects = options.projects;
    this.spawner = options.spawner;
    this.blockers = options.blockers ?? new GhBlockerResolver(options.gh as GhClient);
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? ((err) => console.error("[agentskiss/pipeline] issue pipeline error:", err));
    // Cap-aware by default: with no `workerConcurrency` set, queueing is
    // bypassed entirely and behavior matches the old UnboundedScheduler.
    this.scheduler =
      options.scheduler ?? new QueueingScheduler({ spawner: this.spawner, onError: (err) => this.onError(err) });
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
        maxConcurrentWorkers: registered.project.settings.workerConcurrency,
      },
    );
  }

  /** Whether this pipeline has accepted the issue for spawn (dedupe view, tests/ops). */
  isAccepted(projectId: string, issueNumber: RefNumber): boolean {
    return this.accepted.has(`${projectId}#${issueNumber}`);
  }

  private async spawnFor(registered: RegisteredProject, issue: Issue, key: string): Promise<void> {
    try {
      const openBlockers = await this.openBlockers(registered, issue);
      if (openBlockers.length > 0) {
        // Blocked: release the dedupe slot so a later redelivery (after the
        // blockers resolve) can spawn. No unblock event exists yet (#11).
        this.accepted.delete(key);
        return;
      }
      // Restart safety: a worker for this issue may already exist in the
      // registry from before a daemon restart.
      const active = await this.spawner.listActiveWorkerIssueNumbers(registered.project.id);
      if (active.has(issue.number)) return;

      const spawned = await this.spawner.spawnWorker(registered.project.id, issue.number);
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
