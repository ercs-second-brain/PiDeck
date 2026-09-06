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

import { type Issue } from "@agentskiss/shared";
import type { PullRequest } from "@agentskiss/shared";

import type { GhClient, RepoRef } from "./gh.js";
import { listIssues, type IssueRecord } from "./issues.js";
import { listPullRequestsWithMeta } from "./pulls.js";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Typed events emitted by the watchers. */
export type GithubWatcherEvent =
  | { type: "issue.created"; at: string; issue: Issue }
  | { type: "issue.assigned"; at: string; issue: Issue }
  | { type: "pull_request.opened"; at: string; pullRequest: PullRequest }
  | { type: "pull_request.updated"; at: string; pullRequest: PullRequest };

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

  /** Starts the loop with an immediate first tick. No-op when already running. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.running = true;
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
          for (const event of await this.pollOnce()) emit(event);
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
}

// ---------------------------------------------------------------------------
// Pull request watcher
// ---------------------------------------------------------------------------

export type PullRequestWatcherOptions = WatcherBaseOptions;

/** Watches open PRs for opened / updated (title, state, CI, reviews) transitions. */
export class PullRequestWatcher {
  private readonly seen = new Map<number, PullRequest>();
  private loop: PollLoop | null = null;

  constructor(private readonly options: PullRequestWatcherOptions) {}

  /** Runs one poll and returns the events it produced (without emitting). */
  async pollOnce(): Promise<GithubWatcherEvent[]> {
    const { gh, projectId, repo, now = () => new Date() } = this.options;
    const pulls = await listPullRequestsWithMeta(gh, projectId, repo);
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
          for (const event of await this.pollOnce()) emit(event);
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
