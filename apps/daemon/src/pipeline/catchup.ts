/**
 * Bounded catch-up sweep for downtime-created issues (issue #50 wiring,
 * extracted).
 *
 * The baseline poll alone would silently miss issues created while the
 * daemon was down, so each project also persists an **issue cursor**
 * (`<stateDir>/issue-cursor/<projectId>.json`): on start, issues numbered
 * strictly above the cursor are swept through the normal spawn matrix in
 * bounded batches (oldest first, {@link CATCH_UP_BATCH_SIZE} per poll — a
 * huge catch-up spreads across polls instead of bursting), and the cursor
 * advances only after a batch is processed. First-ever start of a project
 * (no cursor) keeps the pure baseline behavior — a brand-new project must
 * not spawn its entire existing backlog. Live `issue.created`/`assigned`
 * events advance the cursor too (the wiring's event router), so issues
 * handled by the running daemon are not re-swept on the next restart.
 */

import type { Project } from "@agentskiss/shared";

import type { GhClient } from "../github/gh.js";
import { parseRepoUrl } from "../github/gh.js";
import { listIssuesCreatedAfter } from "../github/issues.js";
import { PollLoop, type GithubWatcherEvent } from "../github/watch.js";
import type { ProjectUnit } from "./unit-builder.js";

/**
 * Max issues processed per catch-up batch (issue #50): on start, the sweep
 * of downtime-created issues processes at most this many per poll tick,
 * advances the cursor, and continues on the next tick — a huge backlog is
 * caught up over multiple polls instead of bursting.
 */
export const CATCH_UP_BATCH_SIZE = 25;

/** Everything the sweep needs from the owning {@link GithubAutomation}. */
export interface CatchUpDeps {
  gh: (repoUrl: string) => GhClient;
  /** The registered project for an id (username rule), or `undefined`. */
  getProject: (projectId: string) => Project | undefined;
  /** The shared watcher-event router (feeds the spawn matrix, advances cursors). */
  handleWatcherEvent: (projectId: string, event: GithubWatcherEvent) => void;
  /** Whether the automation is running (a stopped unit re-sweeps). */
  isRunning: () => boolean;
  /** Whether `unit` is still the live unit for its project. */
  isLiveUnit: (unit: ProjectUnit) => boolean;
  pollIntervalMs: number;
  now: () => Date;
  onError: (err: unknown, where: string) => void;
}

export class CatchUpSweep {
  constructor(private readonly deps: CatchUpDeps) {}

  /**
   * Runs one bounded catch-up batch per project (or for one project) —
   * the sweep of issues numbered above the persisted cursor. Test/ops
   * hook: the running catch-up loop sweeps by itself, one batch per poll
   * tick. Returns after the batch is processed (spawn matrix included);
   * safe to call when no catch-up is pending (the fetch finds nothing
   * above the cursor and the batch is a no-op).
   */
  async pollBatch(units: Iterable<ProjectUnit>, projectId?: string): Promise<void> {
    for (const unit of units) {
      if (projectId !== undefined && unit.projectId !== projectId) continue;
      if (unit.issueWatcher === null || unit.issueCursor.lastSeenIssueNumber === null) continue;
      if (await this.runBatch(unit)) this.stopLoop(unit);
    }
  }

  /**
   * Cursor reconciliation after the baseline poll (issue #50):
   *
   * - **No cursor** (first-ever start of this project): persist the current
   *   backlog's high-water mark — pure baseline, no retro-spawn.
   * - **Cursor behind the snapshot**: issues were created while the daemon
   *   was down — run the first bounded catch-up batch now and, if more
   *   remain, spread the rest across the poll ticks.
   */
  async reconcileAfterBaseline(unit: ProjectUnit): Promise<void> {
    const highest = unit.issueWatcher?.highestSeenIssueNumber ?? null;
    const cursor = unit.issueCursor.lastSeenIssueNumber;
    if (cursor === null) {
      // First-ever start: baseline today's backlog instead of spawning it.
      if (highest !== null) unit.issueCursor.set(highest);
      return;
    }
    if (highest === null || highest <= cursor) return; // nothing to catch up
    try {
      if (!(await this.runBatch(unit))) return;
    } catch (err) {
      this.deps.onError(err, `issue-catchup:${unit.projectId}`);
    }
    this.startLoop(unit); // more remain (or the batch failed): retry on the next poll tick
  }

  /** Starts (once) the per-poll loop that continues a catch-up sweep. */
  startLoop(unit: ProjectUnit): void {
    if (unit.catchUpLoop !== null) return;
    const loop: PollLoop = new PollLoop(
      async () => {
        if (await this.runBatch(unit)) this.stopLoop(unit);
      },
      this.deps.pollIntervalMs,
      (err) => this.deps.onError(err, `issue-catchup:${unit.projectId}`),
    );
    unit.catchUpLoop = loop;
    // First tick delayed: the sweep's first batch already ran at activation;
    // subsequent batches spread one per poll tick (issue #50).
    loop.start({ immediate: false });
  }

  stopLoop(unit: ProjectUnit): void {
    unit.catchUpLoop?.stop();
    unit.catchUpLoop = null;
  }

  /**
   * Runs one bounded catch-up batch for a unit (issue #50): fetches the
   * oldest open issues numbered above the cursor ({@link CATCH_UP_BATCH_SIZE}
   * max), feeds each username-matching one through the normal spawn matrix
   * (blocked/duplicate/cap semantics identical to the live path), then —
   * only after the batch has been processed — advances the cursor past it.
   * Issues ≤ the cursor are never spawned. Returns `true` when the sweep is
   * complete (fewer than a full batch remained).
   */
  async runBatch(unit: ProjectUnit): Promise<boolean> {
    const cursor = unit.issueCursor.lastSeenIssueNumber;
    if (cursor === null) return true; // no cursor: nothing to sweep
    const records = await listIssuesCreatedAfter(
      this.deps.gh(unit.repoUrl),
      unit.projectId,
      parseRepoUrl(unit.repoUrl),
      { afterNumber: cursor, first: CATCH_UP_BATCH_SIZE },
    );
    const username = this.deps.getProject(unit.projectId)?.settings.autoAgentUsername ?? null;
    let highest = cursor;
    for (const record of records) {
      // Same username rule as the live watcher (`IssueWatcher.matches`):
      // created by or assigned to the auto-agent username.
      if (username !== null && (record.author === username || record.assignees.includes(username))) {
        this.deps.handleWatcherEvent(unit.projectId, {
          type: "issue.created",
          at: this.deps.now().toISOString(),
          issue: record.issue,
        });
      }
      if (record.issue.number > highest) highest = record.issue.number;
    }
    // Advance only after the batch went through the spawn matrix, and only
    // while this unit is still the live one (a stopped unit re-sweeps).
    if (highest > cursor && this.deps.isRunning() && this.deps.isLiveUnit(unit)) {
      unit.issueCursor.set(highest);
    }
    return records.length < CATCH_UP_BATCH_SIZE;
  }
}
