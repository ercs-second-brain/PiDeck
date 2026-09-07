/**
 * Poll-based watchers for issues and pull requests.
 *
 * Both watchers diff each poll against the previous snapshot and return /
 * emit typed events. Events carry the shared-contract {@link Issue} and
 * {@link PullRequest} entities. (The shared package does not yet define an
 * issue/PR event union — see PR notes — so the event types live here.)
 *
 * Design: `pollOnce()` is pure-ish and returns the events of that tick, so
 * tests drive it directly; `start()`/`stop()` wrap it in a sequential
 * timeout loop for long-running daemon use.
 */

import { githubWatcherEventSchema, type PullRequest } from "@agentskiss/shared";
import type { GithubWatcherEvent } from "@agentskiss/shared";

import type { GhClient, RepoRef } from "./gh.js";
import { listIssues, type IssueRecord } from "./issues.js";
import { listOpenPullRequestsBatched } from "./pulls.js";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Typed events emitted by the watchers — the shared contract
 * (`githubWatcherEventSchema` in @agentskiss/shared), re-exported for
 * consumers. Emitted values are validated against the schema at the emit
 * boundary.
 */
export type { GithubWatcherEvent };

/** Validates one watcher event against the shared contract before emission. */
function validated(event: GithubWatcherEvent): GithubWatcherEvent {
  return githubWatcherEventSchema.parse(event);
}

export type WatcherEventEmitter = (event: GithubWatcherEvent) => void;

export const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface WatcherBaseOptions {
  gh: GhClient;
  projectId: string;
  repo: RepoRef;
  /** Milliseconds between polls. Default: 30s. */
  pollIntervalMs?: number;
  /** Event sink. */
  emit: WatcherEventEmitter;
  /** Poll error sink (polling continues after errors). Default: console.error. */
  onError?: (err: unknown) => void;
  /** Injectable clock (tests). */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Poll loop plumbing
// ---------------------------------------------------------------------------

/** Sequential timeout loop: each poll starts only after the previous one finished. */
export class PollLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;

  constructor(
    private readonly tick: () => Promise<void>,
    private readonly intervalMs: number,
    private readonly onError: (err: unknown) => void,
  ) {}

  /**
   * Starts the loop. By default the first tick is immediate; pass
   * `{ immediate: false }` to schedule the first tick after one interval
   * (used by the catch-up sweep, whose first batch runs at activation).
   * No-op when already running.
   */
  start(options: { immediate?: boolean } = {}): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.running = true;
    if (options.immediate === false) {
      this.timer = setTimeout(() => void this.run(), this.intervalMs);
      this.timer.unref?.();
      return;
    }
    void this.run();
  }

  /** Stops the loop; the in-flight tick (if any) may still complete. */
  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async run(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.tick();
    } catch (err) {
      this.onError(err);
    }
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.run(), this.intervalMs);
    this.timer.unref?.();
  }
}

// ---------------------------------------------------------------------------
// Issue watcher
// ---------------------------------------------------------------------------

export interface IssueWatcherOptions extends WatcherBaseOptions {
  /**
   * Username to watch for: emits `issue.created` for issues authored by or
   * assigned to this login, and `issue.assigned` when the login becomes an
   * assignee of a previously-seen issue. `null` watches every issue.
   */
  username: string | null;
}

/** Watches issue created / assigned transitions. */
export class IssueWatcher {
  private readonly seen = new Map<number, IssueRecord>();
  private loop: PollLoop | null = null;

  constructor(private readonly options: IssueWatcherOptions) {}

  /** Runs one poll and returns the events it produced (without emitting). */
  async pollOnce(): Promise<GithubWatcherEvent[]> {
    const { gh, projectId, repo, username, now = () => new Date() } = this.options;
    const records = await listIssues(gh, projectId, repo, { state: "open" });
    const events: GithubWatcherEvent[] = [];
    for (const record of records) {
      const prev = this.seen.get(record.issue.number);
      this.seen.set(record.issue.number, record);
      if (prev === undefined) {
        if (this.matches(record)) {
          events.push({ type: "issue.created", at: now().toISOString(), issue: record.issue });
        }
        continue;
      }
      const becameAssigned =
        username !== null && record.assignees.includes(username) && !prev.assignees.includes(username);
      if (becameAssigned) {
        events.push({ type: "issue.assigned", at: now().toISOString(), issue: record.issue });
      }
    }
    return events;
  }

  /** Starts polling; every tick's events are passed to `options.emit`. */
  start(): void {
    if (this.loop === null) {
      const { pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, emit, onError = defaultOnError } = this.options;
      this.loop = new PollLoop(
        async () => {
          for (const event of await this.pollOnce()) emit(validated(event));
        },
        pollIntervalMs,
        onError,
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

  private matches(record: IssueRecord): boolean {
    const { username } = this.options;
    if (username === null) return true;
    return record.author === username || record.assignees.includes(username);
  }

  /**
   * Highest issue number in the current snapshot (`null` when nothing has
   * been seen yet). The daemon wiring uses this to persist the issue cursor
   * after a baseline poll (issue #50).
   */
  get highestSeenIssueNumber(): number | null {
    let highest: number | null = null;
    for (const number of this.seen.keys()) {
      if (highest === null || number > highest) highest = number;
    }
    return highest;
  }
}

// ---------------------------------------------------------------------------
// Pull request watcher
// ---------------------------------------------------------------------------

export interface PullRequestWatcherOptions extends WatcherBaseOptions {
  /**
   * Max open PRs fetched per poll (top N by last update). Default 100.
   * Per-poll cost is a single GraphQL call regardless of this value.
   */
  first?: number;
}

/**
 * Watches open PRs for opened / updated (title, state, CI, reviews) transitions.
 *
 * Each poll fetches every watched PR's CI status and review decision in one
 * batched GraphQL call ({@link listOpenPullRequestsBatched}) — O(1) gh calls
 * per poll regardless of open-PR count (issue #42), instead of the O(PR)
 * REST enrichment loop. Granularity note (same as the API listing): the
 * commit-status rollup cannot distinguish "running" CI (it maps to
 * `"pending"`), and only the top `first` most-recently-updated open PRs are
 * watched. Updates remain triggered by the full `prSignature` diff
 * (title/state/CI/review/branches/updatedAt), so event fidelity is
 * preserved.
 */
export class PullRequestWatcher {
  private readonly seen = new Map<number, PullRequest>();
  private loop: PollLoop | null = null;

  constructor(private readonly options: PullRequestWatcherOptions) {}

  /** Runs one poll and returns the events it produced (without emitting). */
  async pollOnce(): Promise<GithubWatcherEvent[]> {
    const { gh, projectId, repo, first, now = () => new Date() } = this.options;
    const pulls = await listOpenPullRequestsBatched(gh, projectId, repo, { first });
    const events: GithubWatcherEvent[] = [];
    for (const pr of pulls) {
      const prev = this.seen.get(pr.number);
      this.seen.set(pr.number, pr);
      if (prev === undefined) {
        events.push({ type: "pull_request.opened", at: now().toISOString(), pullRequest: pr });
      } else if (prSignature(pr) !== prSignature(prev)) {
        events.push({ type: "pull_request.updated", at: now().toISOString(), pullRequest: pr });
      }
    }
    // Note: PRs that leave the "open" set (merged/closed) are intentionally
    // not re-emitted; consumers keep the last known state via `seen`.
    return events;
  }

  /** Starts polling; every tick's events are passed to `options.emit`. */
  start(): void {
    if (this.loop === null) {
      const { pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, emit, onError = defaultOnError } = this.options;
      this.loop = new PollLoop(
        async () => {
          for (const event of await this.pollOnce()) emit(validated(event));
        },
        pollIntervalMs,
        onError,
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
}

// ---------------------------------------------------------------------------

function prSignature(pr: PullRequest): string {
  return JSON.stringify([pr.title, pr.state, pr.ciStatus, pr.reviewState, pr.headBranch, pr.baseBranch, pr.updatedAt]);
}

function defaultOnError(err: unknown): void {
  console.error("[agentskiss/github] watcher poll failed:", err);
}
