/**
 * PR lifecycle loop (issue #11): watches PRs opened by the platform's
 * worker sessions, drives CI-fix and review-comment cycles through the
 * workers' pi sessions, and emits kanban card events for the API layer.
 *
 * Association: a PR is tracked when a registered worker's `prNumber`
 * matches it (the session registry is the source of truth for which
 * worker owns which PR; `SessionManager.setWorkerPr` records it).
 *
 * Loop, per tracked PR (poll-driven; watcher events only accelerate
 * discovery) — the state machine itself lives in `drive.ts`:
 *
 * - CI failing and the worker idle → fix prompt (`fixing_ci`), bounded by
 *   `maxFixAttempts` (gated by the `autoFixCi` toggle, issue #106).
 * - New review comments → delivered to the worker (`addressing_review`;
 *   gated by `autoFixReviewComments`, issue #106).
 * - Merged → card `done`; with `terminateOnMerge` (issue #106) the owning
 *   worker's pane is archived, otherwise the pane keeps running as `done`.
 * - Settled CI or any review decision → card `in_review`.
 *
 * Re-watch resilience: tracker state is persisted, so after a daemon
 * restart {@link reconcile} prunes PRs whose worker vanished and the poll
 * loop re-fetches every remaining PR's full state from GitHub and
 * resumes the loop where it left off.
 */

import { ACTIVE_WORKER_STATUSES, type KanbanCard, type KanbanColumn, type PullRequest, type Worker, type WorkerStatus } from "@pideck/shared";

import type { GhClient, RepoRef } from "../../github/gh.js";
import { pullRequestColumn } from "../../api/kanban.js";
import { enrichPullRequest, fetchReviewComments, getFailingChecks, listPullRequests, mapRestPull } from "../../github/pulls.js";
import { DEFAULT_POLL_INTERVAL_MS, PollLoop, type GithubWatcherEvent } from "../../github/watch.js";
import type { PRPipelineEvent, PRPipelineEventEmitter } from "./events.js";
import { driveLoop } from "./drive.js";
import { archiveReviewAgent } from "./review.js";
import { DEFAULT_WORKER_PIPELINE_SETTINGS, type WorkerPipelineSettings } from "./settings.js";
import { PRTracker, type TrackedPR } from "./tracker.js";
import { prCardId } from "@pideck/shared";

/** Default bound on consecutive CI-fix attempts per PR. */
export const DEFAULT_MAX_FIX_ATTEMPTS = 5;

/** Default age at which an unanswered prompt is treated as stale. */
const DEFAULT_FIX_PROMPT_TIMEOUT_MS = 15 * 60_000;

/**
 * The slice of {@link import("../sessions/manager.js").SessionManager} the
 * pipeline needs. Structural: the real SessionManager satisfies it, tests
 * inject a fake.
 */
export interface PRSessionControl {
  listWorkers(filter?: { projectId?: string; status?: WorkerStatus }): Worker[];
  getWorker(workerId: string): Worker | undefined;
  updateWorkerStatus(workerId: string, status: WorkerStatus, statusMessage?: string): Worker;
  sendKeys(sessionId: string, keys: string, options?: { enter?: boolean }): Promise<void>;
  /**
   * Terminates a worker (kills its tmux pane, marks `archived`) — used when
   * its PR merges and `terminateOnMerge` is on (issue #106), and for review
   * agents reaching the end of their cycle (issue #107). Optional: the
   * all-`done` legacy behavior applies when absent.
   */
  archiveWorker?(workerId: string, message?: string): Promise<Worker | null>;
  /**
   * Spawns the auto review agent for a PR (issue #107): a reviewer-kind
   * worker nested under `parentWorkerId` (the PR-authoring worker) with the
   * review prompt gated on pi readiness. Optional: when absent, the review
   * cycle is skipped (legacy hosts/fakes).
   */
  spawnReviewAgent?(
    projectId: string,
    request: { prNumber: number; parentWorkerId: string | null; prompt: string },
  ): Promise<Worker | null>;
  /**
   * Worker-concurrency occupancy for a project (issue #393): the ONE
   * shared predicate every spawn path gates the `workerConcurrency` cap
   * with — the project's active workers plus its live workerLike
   * agent-kind sessions (`sessions/occupancy.ts`). Required so a project
   * at its cap of workerLike kind sessions also gates review-agent
   * spawns, not just worker spawns.
   */
  countProjectOccupants(projectId: string): number;
}

export interface PullRequestPipelineOptions {
  gh: GhClient;
  projectId: string;
  repo: RepoRef;
  /** Session manager facade (or fake) used to prompt workers and read the registry. */
  sessions: PRSessionControl;
  tracker: PRTracker;
  /** Kanban event sink for the API layer (#9). */
  emit: PRPipelineEventEmitter;
  /**
   * Worker-pipeline toggles (issue #106), read fresh on every decision.
   * Default: all ON.
   */
  workerSettings?: () => WorkerPipelineSettings;
  /**
   * Max concurrent workers for the PR's project (issue #107 review-agent
   * spawns respect the cap); `undefined` = unbounded.
   */
  workerCap?: () => number | undefined;
  /** Max consecutive CI-fix prompts per red streak. Default: {@link DEFAULT_MAX_FIX_ATTEMPTS}. */
  maxFixAttempts?: number;
  /** Age at which an unanswered fix/address prompt is treated as stale. Default: 15 min. */
  fixPromptTimeoutMs?: number;
  /** Milliseconds between polls. Default: {@link DEFAULT_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Poll error sink (polling continues after errors). Default: console.error. */
  onError?: (err: unknown) => void;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export class PullRequestPipeline {
  private readonly maxFixAttempts: number;
  private readonly fixPromptTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly onError: (err: unknown) => void;
  private readonly now: () => Date;
  private loop: PollLoop | null = null;

  constructor(private readonly options: PullRequestPipelineOptions) {
    this.maxFixAttempts = options.maxFixAttempts ?? DEFAULT_MAX_FIX_ATTEMPTS;
    this.fixPromptTimeoutMs = options.fixPromptTimeoutMs ?? DEFAULT_FIX_PROMPT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.onError = options.onError ?? defaultOnError;
    this.now = options.now ?? (() => new Date());
  }

  // -- lifecycle -------------------------------------------------------------

  /** Starts the poll loop (immediate first tick). No-op when already running. */
  start(): void {
    if (this.loop === null) {
      this.loop = new PollLoop(
        async () => {
          for (const event of await this.pollOnce()) this.options.emit(event);
        },
        this.pollIntervalMs,
        this.onError,
      );
    }
    this.loop.start();
  }

  stop(): void {
    this.loop?.stop();
  }

  get isRunning(): boolean {
    return this.loop?.isRunning ?? false;
  }

  // -- inputs ----------------------------------------------------------------

  /**
   * Handles a watcher event. `pull_request.opened` / `updated` of a
   * worker-owned PR are registered (or re-associated after a restart);
   * full state is resolved by the next poll. Returns the events produced.
   */
  handleWatcherEvent(event: GithubWatcherEvent): PRPipelineEvent[] {
    if (event.type !== "pull_request.opened" && event.type !== "pull_request.updated") return [];
    const pr = event.pullRequest;
    const tracked = this.tracker.get(pr.projectId, pr.number);
    if (tracked !== undefined) {
      tracked.title = pr.title;
      return [];
    }
    const cardEvent = this.trackIfOwned(pr);
    this.tracker.save();
    return cardEvent === null ? [] : [cardEvent];
  }

  /**
   * One reconcile pass over every tracked PR: discovers newly opened
   * worker-owned PRs, fetches each tracked PR's current state (head SHA,
   * CI, review decision, comments) and drives the state machine. Also the
   * re-watch path after a daemon restart.
   */
  async pollOnce(): Promise<PRPipelineEvent[]> {
    const events: PRPipelineEvent[] = [];
    try {
      const records = await listPullRequests(this.gh, this.projectId, this.repo, "open");
      for (const { pullRequest } of records) {
        const cardEvent = this.trackIfOwned(pullRequest);
        if (cardEvent !== null) events.push(cardEvent);
      }
    } catch (err) {
      this.onError(err);
    }
    for (const tracked of this.tracker.listActive()) {
      try {
        events.push(...(await this.processTracked(tracked)));
      } catch (err) {
        this.onError(err);
      }
    }
    this.tracker.save();
    return events;
  }

  /**
   * Startup reconciliation after a daemon restart: drops tracked PRs whose
   * owning worker no longer exists in the registry (emitting
   * `kanban.pr.failed`); surviving PRs are resumed by the next poll.
   */
  reconcile(): PRPipelineEvent[] {
    const events: PRPipelineEvent[] = [];
    for (const tracked of this.tracker.listActive()) {
      if (this.sessions.getWorker(tracked.workerId) === undefined) {
        events.push(...this.failTracked(tracked, "worker_lost", "failed", "owning worker no longer exists"));
      }
    }
    this.tracker.save();
    return events;
  }

  // -- state machine -----------------------------------------------------------

  private async processTracked(tracked: TrackedPR): Promise<PRPipelineEvent[]> {
    const events: PRPipelineEvent[] = [];
    const raw = await this.gh.apiJson<unknown>(`/repos/${this.repo.owner}/${this.repo.repo}/pulls/${tracked.prNumber}`);
    const record = mapRestPull(tracked.projectId, raw);
    const pr = await enrichPullRequest(this.gh, this.repo, record);
    tracked.updatedAt = this.now().toISOString();
    tracked.title = pr.title;

    if (pr.state === "merged") {
      await this.settleMerged(tracked);
      this.pushCard(events, tracked, pr, tracked.updatedAt);
      // Merged-PR notification (issue #111): the webapp toasts "<project>
      // #<n> merged" so the user learns the outcome without watching.
      events.push({
        type: "notification.pr.merged",
        at: tracked.updatedAt,
        projectId: tracked.projectId,
        prNumber: tracked.prNumber,
        title: pr.title,
      });
      return events;
    }
    if (pr.state === "closed") {
      // Closed without merging: terminal, but the loop did not fail — the
      // worker is done, the card is reported failed for the API layer to present.
      tracked.state = "failed";
      await archiveReviewAgent(tracked, this.sessions, `PR #${tracked.prNumber} closed — review agent done`);
      this.setWorkerStatusQuietly(tracked.workerId, "done", `PR #${tracked.prNumber} closed without merging`);
      const card = this.buildCard(tracked, pullRequestColumn(pr), tracked.updatedAt);
      events.push({ type: "kanban.pr.card", at: tracked.updatedAt, card });
      events.push({ type: "kanban.pr.failed", at: tracked.updatedAt, projectId: tracked.projectId, prNumber: tracked.prNumber, workerId: tracked.workerId, card, reason: "pr_closed_without_merge" });
      return events;
    }

    const comments = await fetchReviewComments(this.gh, this.repo, tracked.prNumber);
    events.push(
      ...(await driveLoop(tracked, pr, record.headSha, comments, {
        sessions: this.sessions,
        settings: this.options.workerSettings ?? (() => undefined),
        workerCap: this.options.workerCap ?? (() => undefined),
        repo: `${this.repo.owner}/${this.repo.repo}`,
        // Issue #322: name the failing checks in the CI-fix prompt.
        failingChecks: (headSha) => getFailingChecks(this.gh, this.repo, headSha),
        maxFixAttempts: this.maxFixAttempts,
        fixPromptTimeoutMs: this.fixPromptTimeoutMs,
        now: this.now,
        fail: (t, reason, workerStatus, workerMessage) => this.failTracked(t, reason, workerStatus, workerMessage),
      })),
    );
    tracked.headSha = record.headSha;
    this.pushCard(events, tracked, pr, tracked.updatedAt);
    return events;
  }

  // -- helpers ---------------------------------------------------------------

  private get gh(): GhClient {
    return this.options.gh;
  }

  private get repo(): RepoRef {
    return this.options.repo;
  }

  private get projectId(): string {
    return this.options.projectId;
  }

  private get tracker(): PRTracker {
    return this.options.tracker;
  }

  private get sessions(): PRSessionControl {
    return this.options.sessions;
  }

  /**
   * Registers a PR when a registered worker owns it (registry
   * `worker.prNumber`); returns the initial card event, or `null` when the
   * PR is already tracked or has no owning worker.
   */
  private trackIfOwned(pr: PullRequest): PRPipelineEvent | null {
    if (this.tracker.get(pr.projectId, pr.number) !== undefined) return null;
    const owner = this.findOwner(pr);
    if (owner === undefined) return null;
    const tracked = this.tracker.register({
      projectId: pr.projectId,
      prNumber: pr.number,
      headBranch: pr.headBranch,
      workerId: owner.id,
      sessionId: owner.sessionId,
      title: pr.title,
    });
    this.setWorkerStatusQuietly(owner.id, "awaiting_ci", `PR #${pr.number} opened — watching CI`);
    const at = this.now().toISOString();
    tracked.title = pr.title;
    const event: PRPipelineEvent = {
      type: "kanban.pr.card",
      at,
      card: this.buildCard(tracked, pullRequestColumn(pr), at),
    };
    tracked.cardSignature = cardSignature(pr.title, event.card.column);
    return event;
  }

  private findOwner(pr: PullRequest): Worker | undefined {
    // Review agents (issue #107) record the PR they review but never own it.
    const workers = this.sessions.listWorkers({ projectId: pr.projectId }).filter(
      (w) => w.prNumber === pr.number && w.kind !== "reviewer",
    );
    if (workers.length === 0) return undefined;
    return workers.find((w) => ACTIVE_WORKER_STATUSES.has(w.status)) ?? workers[0];
  }

  /**
   * Merge settlement (issue #106): `terminateOnMerge` archives the owning
   * worker (pane killed, terminal `archived` status); otherwise the pane
   * keeps running under the legacy `done` status.
   */
  private async settleMerged(tracked: TrackedPR): Promise<void> {
    tracked.state = "done";
    await archiveReviewAgent(tracked, this.sessions, `PR #${tracked.prNumber} merged — review agent done`);
    const message = `PR #${tracked.prNumber} merged`;
    const terminateOnMerge = this.options.workerSettings?.().terminateOnMerge ?? DEFAULT_WORKER_PIPELINE_SETTINGS.terminateOnMerge;
    if (terminateOnMerge && this.sessions.archiveWorker !== undefined) {
      try {
        await this.sessions.archiveWorker(tracked.workerId, `${message} — archived on merge`);
        return;
      } catch {
        // Fall through to the quiet status update below.
      }
    }
    this.setWorkerStatusQuietly(tracked.workerId, "done", message);
  }

  /** Terminal failure: stops driving the PR, emits card + failed event. */
  private failTracked(tracked: TrackedPR, reason: string, workerStatus: WorkerStatus, workerMessage: string): PRPipelineEvent[] {
    tracked.state = "failed";
    tracked.updatedAt = this.now().toISOString();
    // The reviewer's job ends with the PR (issue #107); archival is
    // best-effort and never throws.
    void archiveReviewAgent(tracked, this.sessions, `PR #${tracked.prNumber} failed — review agent done`);
    this.setWorkerStatusQuietly(tracked.workerId, workerStatus, workerMessage);
    const card = this.buildCard(tracked, "in_review", tracked.updatedAt);
    return [
      { type: "kanban.pr.card", at: tracked.updatedAt, card },
      {
        type: "kanban.pr.failed",
        at: tracked.updatedAt,
        projectId: tracked.projectId,
        prNumber: tracked.prNumber,
        workerId: tracked.workerId,
        card,
        reason,
      },
    ];
  }

  private pushCard(events: PRPipelineEvent[], tracked: TrackedPR, pr: PullRequest, at: string): void {
    const column = pullRequestColumn(pr);
    const signature = cardSignature(pr.title, column);
    if (tracked.cardSignature === signature) return;
    tracked.cardSignature = signature;
    events.push({ type: "kanban.pr.card", at, card: this.buildCard(tracked, column, at) });
  }

  private buildCard(tracked: TrackedPR, column: KanbanColumn, at: string): KanbanCard {
    return {
      id: prCardId(tracked.projectId, tracked.prNumber),
      projectId: tracked.projectId,
      kind: "pull_request",
      number: tracked.prNumber,
      title: tracked.title,
      column,
      workerId: tracked.workerId,
      updatedAt: at,
    };
  }

  private setWorkerStatusQuietly(workerId: string, status: WorkerStatus, statusMessage: string): void {
    try {
      this.sessions.updateWorkerStatus(workerId, status, statusMessage);
    } catch {
      // The worker record vanished (e.g. deleted between polls); the PR
      // loop keeps running and reconcile() cleans up if it stays gone.
    }
  }
}

function cardSignature(title: string, column: KanbanColumn): string {
  return `${title}\u0000${column}`;
}

function defaultOnError(err: unknown): void {
  console.error("[pideck/pipeline/prs] poll failed:", err);
}
