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
 * discovery):
 *
 * - CI failing and the worker idle → send a fix prompt via tmux
 *   sendKeys (`fixing_ci`), bounded by `maxFixAttempts` consecutive
 *   attempts (reset whenever CI goes green). Exhausted → `kanban.pr.failed`
 *   and the PR stops being driven — no infinite fix-push cycles.
 * - A prompt is never re-sent while the worker is still on the same head
 *   SHA; a push (new head) re-arms evaluation ("re-watch on push"). A
 *   prompt older than `fixPromptTimeoutMs` is treated as unanswered.
 * - New review comments (watermarked by comment id) → delivered to the
 *   worker for addressing (`addressing_review`), including comments that
 *   arrive after fixes.
 * - Merged (or CI-green + approved) → card `done`; merged also completes
 *   the worker.
 *
 * Re-watch resilience: tracker state is persisted, so after a daemon
 * restart {@link reconcile} prunes PRs whose worker vanished and the poll
 * loop re-fetches every remaining PR's full state from GitHub and
 * resumes the loop where it left off.
 */

import type { KanbanCard, KanbanColumn, PullRequest, Worker, WorkerStatus } from "@agentskiss/shared";

import type { GhClient, RepoRef } from "../../github/gh.js";
import { enrichPullRequest, fetchReviewComments, listPullRequests, mapRestPull, type PRReviewComment } from "../../github/pulls.js";
import { DEFAULT_POLL_INTERVAL_MS, PollLoop, type GithubWatcherEvent } from "../../github/watch.js";
import { type PRPipelineEvent, type PRPipelineEventEmitter } from "./events.js";
import { buildCiFixPrompt, buildReviewCommentsPrompt } from "./prompts.js";
import { prCardId, PRTracker, type TrackedPR } from "./tracker.js";

/** Default bound on consecutive CI-fix attempts per PR. */
export const DEFAULT_MAX_FIX_ATTEMPTS = 5;

/** Default age at which an unanswered prompt is treated as stale. */
export const DEFAULT_FIX_PROMPT_TIMEOUT_MS = 15 * 60_000;

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
    const at = this.now().toISOString();
    tracked.updatedAt = at;
    tracked.title = pr.title;

    if (pr.state === "merged") {
      tracked.state = "done";
      this.setWorkerStatusQuietly(tracked.workerId, "done", `PR #${tracked.prNumber} merged`);
      this.pushCard(events, tracked, pr, at);
      return events;
    }
    if (pr.state === "closed") {
      // Closed without merging: terminal, but the loop did not fail — the
      // worker is done, the card is reported failed for the API layer to present.
      tracked.state = "failed";
      this.setWorkerStatusQuietly(tracked.workerId, "done", `PR #${tracked.prNumber} closed without merging`);
      const card = this.buildCard(tracked, cardColumn(pr), at);
      events.push({ type: "kanban.pr.card", at, card });
      events.push({ type: "kanban.pr.failed", at, projectId: tracked.projectId, prNumber: tracked.prNumber, workerId: tracked.workerId, card, reason: "pr_closed_without_merge" });
      return events;
    }

    const comments = await fetchReviewComments(this.gh, this.repo, tracked.prNumber);
    await this.driveLoop(tracked, pr, record.headSha, comments, at, events);
    tracked.headSha = record.headSha;
    this.pushCard(events, tracked, pr, at);
    return events;
  }

  private async driveLoop(
    tracked: TrackedPR,
    pr: PullRequest,
    headSha: string,
    comments: PRReviewComment[],
    at: string,
    events: PRPipelineEvent[],
  ): Promise<void> {
    const newComments = comments.filter((c) => tracked.lastSeenCommentId === null || c.id > tracked.lastSeenCommentId);
    const headChangedSincePrompt = tracked.lastPromptedHeadSha !== null && headSha !== tracked.lastPromptedHeadSha;
    const promptedAt = tracked.lastPromptedAt === null ? null : Date.parse(tracked.lastPromptedAt);
    const promptStale = promptedAt !== null && this.now().getTime() - promptedAt > this.fixPromptTimeoutMs;

    // A worker stuck on a prompt for too long is considered idle again;
    // the branches below then re-prompt (CI red) or deliver deferred comments.
    if ((tracked.state === "fixing" || tracked.state === "addressing") && promptStale) {
      tracked.state = "watching";
    }

    if (pr.ciStatus === "failure") {
      const waitingForWorker = tracked.state === "fixing" && !headChangedSincePrompt;
      if (!waitingForWorker) {
        if (tracked.fixAttempts >= this.maxFixAttempts) {
          events.push(
            ...this.failTracked(
              tracked,
              `fix_attempt_limit_exhausted (${tracked.fixAttempts} attempts)`,
              "failed",
              `PR #${tracked.prNumber}: fix attempt limit (${this.maxFixAttempts}) exhausted — manual intervention required`,
            ),
          );
          return;
        }
        const attempt = tracked.fixAttempts + 1;
        await this.sendPrompt(
          tracked.sessionId,
          buildCiFixPrompt(pr, { attempt, maxAttempts: this.maxFixAttempts, comments: newComments }),
        );
        tracked.fixAttempts = attempt;
        tracked.state = "fixing";
        tracked.lastPromptedAt = at;
        tracked.lastPromptedHeadSha = headSha;
        this.markCommentsSeen(tracked, newComments);
        this.setWorkerStatusQuietly(
          tracked.workerId,
          "fixing_ci",
          `PR #${tracked.prNumber}: CI failed — fix attempt ${attempt}/${this.maxFixAttempts}`,
        );
      }
      return;
    }

    if (pr.ciStatus === "success") {
      tracked.fixAttempts = 0; // the previous red streak ended green
    }
    if (tracked.state === "watching" && newComments.length > 0) {
      await this.sendPrompt(tracked.sessionId, buildReviewCommentsPrompt(pr, newComments));
      tracked.state = "addressing";
      tracked.lastPromptedAt = at;
      tracked.lastPromptedHeadSha = headSha;
      this.markCommentsSeen(tracked, newComments);
      this.setWorkerStatusQuietly(
        tracked.workerId,
        "addressing_review",
        `PR #${tracked.prNumber}: addressing ${newComments.length} review comment(s)`,
      );
    } else if (
      (tracked.state === "fixing" || tracked.state === "addressing") &&
      tracked.lastPromptedHeadSha !== null &&
      headSha !== tracked.lastPromptedHeadSha
    ) {
      // The worker pushed after being prompted — back to watching.
      tracked.state = "watching";
      this.setWorkerStatusQuietly(tracked.workerId, "awaiting_ci", `PR #${tracked.prNumber}: watching CI`);
    }
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
      card: this.buildCard(tracked, cardColumn(pr), at),
    };
    tracked.cardSignature = cardSignature(pr.title, event.card.column);
    return event;
  }

  private findOwner(pr: PullRequest): Worker | undefined {
    const workers = this.sessions.listWorkers({ projectId: pr.projectId }).filter((w) => w.prNumber === pr.number);
    if (workers.length === 0) return undefined;
    return (
      workers.find(
        (w) => w.status !== "done" && w.status !== "failed" && w.status !== "stopped" && w.status !== "archived",
      ) ?? workers[0]
    );
  }

  private async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    await this.sessions.sendKeys(sessionId, prompt, { enter: true });
  }

  private markCommentsSeen(tracked: TrackedPR, comments: PRReviewComment[]): void {
    for (const comment of comments) {
      if (tracked.lastSeenCommentId === null || comment.id > tracked.lastSeenCommentId) {
        tracked.lastSeenCommentId = comment.id;
      }
    }
  }

  /** Terminal failure: stops driving the PR, emits card + failed event. */
  private failTracked(tracked: TrackedPR, reason: string, workerStatus: WorkerStatus, workerMessage: string): PRPipelineEvent[] {
    tracked.state = "failed";
    tracked.updatedAt = this.now().toISOString();
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
    const column = cardColumn(pr);
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

/**
 * Card column for a PR: `done` once merged or CI-green + approved,
 * `in_review` while open. (Failure has no column — it is signalled via
 * the `kanban.pr.failed` event.)
 */
function cardColumn(pr: PullRequest): KanbanColumn {
  if (pr.state === "merged") return "done";
  if (pr.ciStatus === "success" && pr.reviewState === "approved") return "done";
  return "in_review";
}

function cardSignature(title: string, column: KanbanColumn): string {
  return `${title}\u0000${column}`;
}

function defaultOnError(err: unknown): void {
  console.error("[agentskiss/pipeline/prs] poll failed:", err);
}
