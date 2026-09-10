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

import { githubWatcherEventSchema, type PullRequest } from "@pideck/shared";
import type { GithubWatcherEvent } from "@pideck/shared";

import type { GhClient, RepoRef } from "./gh.js";
import { listIssues, type IssueRecord } from "./issues.js";
import { listOpenPullRequestsBatched } from "./pulls.js";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Typed events emitted by the watchers — the shared contract
 * (`githubWatcherEventSchema` in @pideck/shared), re-exported for
 * consumers. Emitted values are validated against the schema at the emit
 * boundary.
 */
export type { GithubWatcherEvent };

/** Validates one watcher event against the shared contract before emission. */
function validated(event: GithubWatcherEvent): GithubWatcherEvent {
  return githubWatcherEventSchema.parse(event);
}

type WatcherEventEmitter = (event: GithubWatcherEvent) => void;

export const DEFAULT_POLL_INTERVAL_MS = 30_000;

interface WatcherBaseOptions {
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
// Watcher base
// ---------------------------------------------------------------------------

/**
 * Shared start/stop plumbing for the concrete watchers (issue #133): both
 * wrap their {@link pollOnce} in a {@link PollLoop} whose tick emits each
 * event validated against the shared contract.
 */
abstract class WatcherBase<O extends WatcherBaseOptions> {
  private loop: PollLoop | null = null;

  constructor(protected readonly options: O) {}

  /** Runs one poll and returns the events it produced (without emitting). */
  abstract pollOnce(): Promise<GithubWatcherEvent[]>;

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
// Issue watcher
// ---------------------------------------------------------------------------

/**
 * Assignment-driven spawning (issue #416) watches every open issue — there
 * is no per-user filter anymore; the pipeline spawns on any
 * `issue.assigned` transition, so no extra options beyond the base.
 */
export type IssueWatcherOptions = WatcherBaseOptions;

/**
 * Watches issue lifecycle transitions: `issue.created` for newly seen open
 * issues, `issue.assigned` when an issue gains a new assignee (any user —
 * issue #416's spawn trigger), `issue.unassigned` when a previously
 * assigned issue loses all assignees, and `issue.closed` when a
 * previously-seen open issue disappears from the open-issues poll.
 */
export class IssueWatcher extends WatcherBase<IssueWatcherOptions> {
  private readonly seen = new Map<number, IssueRecord>();

  constructor(options: IssueWatcherOptions) {
    super(options);
  }

  /** Runs one poll and returns the events it produced (without emitting). */
  async pollOnce(): Promise<GithubWatcherEvent[]> {
    const { gh, projectId, repo, now = () => new Date() } = this.options;
    const records = await listIssues(gh, projectId, repo, { state: "open" });
    const events: GithubWatcherEvent[] = [];
    const seenNow = new Set<number>();
    for (const record of records) {
      seenNow.add(record.issue.number);
      const prev = this.seen.get(record.issue.number);
      this.seen.set(record.issue.number, record);
      if (prev === undefined) {
        events.push({ type: "issue.created", at: now().toISOString(), issue: record.issue });
        continue;
      }
      if (record.assignees.length > prev.assignees.length) {
        events.push({ type: "issue.assigned", at: now().toISOString(), issue: record.issue });
      } else if (prev.assignees.length > 0 && record.assignees.length === 0) {
        events.push({ type: "issue.unassigned", at: now().toISOString(), issue: record.issue });
      }
    }
    // A previously-seen open issue that vanished from the open poll was
    // closed (the poll fetches state:open only). Emit + forget so a reopen
    // is seen as a fresh issue again.
    for (const [number, record] of this.seen) {
      if (!seenNow.has(number)) {
        this.seen.delete(number);
        events.push({ type: "issue.closed", at: now().toISOString(), issue: record.issue });
      }
    }
    return events;
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
export class PullRequestWatcher extends WatcherBase<PullRequestWatcherOptions> {
  private readonly seen = new Map<number, PullRequest>();

  constructor(options: PullRequestWatcherOptions) {
    super(options);
  }

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

}

// ---------------------------------------------------------------------------

function prSignature(pr: PullRequest): string {
  return JSON.stringify([pr.title, pr.state, pr.ciStatus, pr.reviewState, pr.headBranch, pr.baseBranch, pr.updatedAt]);
}

function defaultOnError(err: unknown): void {
  console.error("[pideck/github] watcher poll failed:", err);
}
