/**
 * Daemon wiring for the GitHub automation loop (issue #46).
 *
 * The watcher and pipeline modules (`github/watch.ts`, `pipeline/issues/`,
 * `pipeline/prs/`) are fully built libraries; this module is the wiring the
 * daemon entry point calls into. It owns constructing and starting, per
 * registered project:
 *
 * - an {@link IssueWatcher} (only when the project has auto-spawn enabled,
 *   i.e. `settings.autoAgentUsername !== null`) feeding the shared
 *   {@link IssueSpawnPipeline};
 * - a {@link PullRequestWatcher} feeding the project's
 *   {@link PullRequestPipeline};
 * - a persisted {@link PRTracker} per project
 *   (`<stateDir>/pr-tracker/<projectId>.json`), so the PR loop survives
 *   daemon restarts.
 *
 * plus **one** project-routing {@link IssueSpawnPipeline} whose kanban
 * events and the PR pipelines' card events are converted to shared
 * `KanbanUpdateEvent`s and broadcast on the WS hub, so connected webapps
 * see boards move live.
 *
 * Worker↔PR association: the PR loop tracks a PR when a registered
 * worker's `prNumber` matches it (`SessionManager.setWorkerPr` records
 * that on the session registry). Workers don't report PRs themselves, so
 * this wiring performs the association when the PR watcher reports a PR:
 * if the PR's title/head branch references the issue a non-terminal,
 * unassociated worker is working on (`#46`, `issue 46`, `issue-46`, …),
 * the worker is recorded as the PR owner.
 *
 * Trigger semantics (pinned per issue #46's decision): auto-spawn fires
 * when an issue is **created by the configured auto-agent username, or
 * assigned to it** — the PRD wording. The watcher is constructed with the
 * project's `autoAgentUsername`, so `issue.created` only ever fires for
 * issues authored by that user (or already assigned to them) and
 * `issue.assigned` only for assignment transitions to them; the pipeline's
 * permissive `issue.created` filter (any author) never sees other authors.
 *
 * Start ordering (daemon entry point): session reconciliation →
 * orchestrator bootstrap → `automation.start()`. `start()` first runs a
 * **baseline sweep** of each new issue watcher — seeding the watcher's
 * snapshot and discarding its events — so the live watcher only spawns for
 * issues that appear or change *while it is running*. The baseline alone
 * would silently miss issues created while the daemon was down, so each
 * project also persists an **issue cursor** (issue #50,
 * `<stateDir>/issue-cursor/<projectId>.json`): on start, issues numbered
 * strictly above the cursor are swept through the normal spawn matrix in
 * bounded batches (oldest first, {@link CATCH_UP_BATCH_SIZE} per poll — a
 * huge catch-up spreads across polls instead of bursting), and the cursor
 * advances only after a batch is processed. First-ever start of a project
 * (no cursor) keeps the pure baseline behavior — a brand-new project must
 * not spawn its entire existing backlog. Live `issue.created`/`assigned`
 * events advance the cursor too, so issues handled by the running daemon
 * are not re-swept on the next restart.
 * (PR discovery needs no baseline: the PR loop's own poll re-discovers
 * worker-owned PRs, and watcher events accelerate association only.)
 *
 * Shutdown ordering: `stop()` first (halts all polling and pipelines), then
 * the rest of the daemon tears down.
 *
 * API rate budget (why the knobs exist): per enabled project, every poll
 * costs one REST issues-list call (issue watcher, only when auto-spawn is
 * enabled) + one batched GraphQL open-PR listing (PR watcher) + the PR
 * loop's per-tracked-PR enrichment (one REST pull + one check-run/review
 * batch + one comments call per tracked PR). At the default 30s interval
 * an idle project costs ~4 calls/30s; size `AGENTSKISS_WATCHER_POLL_INTERVAL_MS`
 * accordingly.
 *
 * Environment:
 * - `AGENTSKISS_WATCHER_ENABLED`            set to `0`/`false` to disable
 *                                           the watcher/pipeline loop (default on)
 * - `AGENTSKISS_WATCHER_POLL_INTERVAL_MS`   poll interval for all watchers
 *                                           and the PR loop (default 30s)
 */

import path from "node:path";

import type { Issue, IssueBlocker, KanbanColumn, KanbanUpdateEvent, PullRequest, WorkerStatus } from "@agentskiss/shared";
import { workerSchema } from "@agentskiss/shared";

import type { GhClient, RepoRef } from "../github/gh.js";
import { formatRepoRef, parseRepoUrl } from "../github/gh.js";
import { listIssuesCreatedAfter } from "../github/issues.js";
import { GhBlockerResolver } from "./issues/blockers.js";
import { IssueCursor } from "./issues/cursor.js";
import { IssueSpawnPipeline } from "./issues/pipeline.js";
import type { BlockerResolver, ProjectSource, RegisteredProject, WorkerSpawner } from "./issues/ports.js";
import { SessionManagerSpawner } from "./issues/ports.js";
import { PullRequestPipeline, type PRSessionControl } from "./prs/pipeline.js";
import type { PRPipelineEvent } from "./prs/events.js";
import { PRTracker } from "./prs/tracker.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  IssueWatcher,
  PollLoop,
  PullRequestWatcher,
  type GithubWatcherEvent,
} from "../github/watch.js";
import type { ProjectService } from "../api/projects.js";
import type { SessionManager } from "../sessions/manager.js";
import type { WsHub } from "../api/ws.js";

/** Default poll interval for all watchers/loops (30s — see the budget above). */
export { DEFAULT_POLL_INTERVAL_MS as DEFAULT_WATCHER_POLL_INTERVAL_MS } from "../github/watch.js";

/** Worker statuses that may own a PR (mirrors the active-spawn statuses). */
const PR_OWNABLE_STATUSES = new Set<WorkerStatus>([
  "spawning",
  "running",
  "awaiting_ci",
  "fixing_ci",
  "addressing_review",
]);

/** Resolves the watcher knobs from the environment (options win over env). */
export function watcherOptionsFromEnv(
  env: NodeJS.ProcessEnv,
  overrides: { enabled?: boolean; pollIntervalMs?: number } = {},
): { enabled: boolean; pollIntervalMs: number } {
  const enabledFlag = env["AGENTSKISS_WATCHER_ENABLED"]?.trim().toLowerCase();
  const enabled =
    overrides.enabled ??
    (enabledFlag === undefined || enabledFlag.length === 0 ? true : !(enabledFlag === "0" || enabledFlag === "false"));
  const rawInterval = Number(env["AGENTSKISS_WATCHER_POLL_INTERVAL_MS"]);
  const pollIntervalMs =
    overrides.pollIntervalMs ?? (Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : DEFAULT_POLL_INTERVAL_MS);
  return { enabled, pollIntervalMs };
}

/** Project ids are slugified (`api/projects.ts`), so they are filename-safe. */
function trackerFilePath(stateDir: string, projectId: string): string {
  return path.join(stateDir, "pr-tracker", `${projectId}.json`);
}

/** Issue-cursor file for a project (`<stateDir>/issue-cursor/<projectId>.json`). */
function cursorFilePath(stateDir: string, projectId: string): string {
  return path.join(stateDir, "issue-cursor", `${projectId}.json`);
}

/**
 * Max issues processed per catch-up batch (issue #50): on start, the sweep
 * of downtime-created issues processes at most this many per poll tick,
 * advances the cursor, and continues on the next tick — a huge backlog is
 * caught up over multiple polls instead of bursting.
 */
export const CATCH_UP_BATCH_SIZE = 25;

/** The registered project for an id, with its parsed repo ref. */
function registeredProject(projects: ProjectService, projectId: string): RegisteredProject | undefined {
  const project = projects.get(projectId);
  if (project === undefined) return undefined;
  try {
    return { project, repo: parseRepoUrl(project.repoUrl) };
  } catch {
    return undefined; // unparseable repoUrl: not watchable
  }
}

/** Issue numbers referenced in free text: `#46`, `issue 46`, `issue-46`, `Issue_46`. */
function referencedIssueNumbers(text: string): Set<number> {
  const refs = new Set<number>();
  for (const match of text.matchAll(/#(\d+)\b/g)) refs.add(Number(match[1]));
  for (const match of text.matchAll(/\bissue[-_ ]?(\d+)\b/gi)) refs.add(Number(match[1]));
  return refs;
}

/**
 * Blocker resolver that routes to the right project's `GhClient` (the gh
 * factory is keyed by repo URL; the issue pipeline is project-agnostic).
 */
class RoutingBlockerResolver implements BlockerResolver {
  constructor(
    private readonly projects: ProjectService,
    private readonly gh: (repoUrl: string) => GhClient,
    private readonly onError: (err: unknown, where: string) => void,
  ) {}

  async resolve(repo: RepoRef, issue: Issue): Promise<IssueBlocker[]> {
    for (const project of this.projects.list()) {
      let parsed: RepoRef;
      try {
        parsed = parseRepoUrl(project.repoUrl);
      } catch {
        continue;
      }
      if (parsed.owner !== repo.owner || parsed.repo !== repo.repo) continue;
      return new GhBlockerResolver(this.gh(project.repoUrl)).resolve(repo, issue);
    }
    this.onError(new Error(`no registered project for repo ${formatRepoRef(repo)}`), `blockers:${formatRepoRef(repo)}`);
    return [];
  }
}

interface ProjectUnit {
  projectId: string;
  repoUrl: string;
  /** Identity of the settings that produced this unit — change ⇒ rebuild. */
  configKey: string;
  issueWatcher: IssueWatcher | null;
  /** Persisted high-water mark of processed issue numbers (issue #50). */
  issueCursor: IssueCursor;
  /** Catch-up sweep loop (`null` when no catch-up is in progress). */
  catchUpLoop: PollLoop | null;
  prWatcher: PullRequestWatcher;
  tracker: PRTracker;
  prPipeline: PullRequestPipeline;
  /** Last broadcast kanban column per PR card id (`from` for card.moved). */
  lastColumns: Map<string, KanbanColumn>;
}

export interface GithubAutomationOptions {
  projects: ProjectService;
  sessions: SessionManager;
  hub: WsHub;
  /** GhClient factory, keyed by repo URL (the daemon context's factory). */
  gh: (repoUrl: string) => GhClient;
  /** Daemon state dir (PR tracker persistence lives under `<stateDir>/pr-tracker/`). */
  stateDir: string;
  /** Master switch. Default: resolved from the environment (on). */
  enabled?: boolean;
  /** Poll interval for watchers and the PR loop. Default: 30s or env. */
  pollIntervalMs?: number;
  /** Injectable clock (ISO timestamps for events). */
  now?: () => Date;
  /** Error sink for poll/spawn/broadcast failures. Default: console.error. */
  onError?: (err: unknown, where: string) => void;
}

/**
 * The daemon's GitHub automation: watcher + issue/PR pipelines, wired to
 * the session registry and the WS hub. Constructed by the daemon context;
 * the entry point calls {@link start} after session reconciliation and
 * {@link stop} first on shutdown.
 */
export class GithubAutomation {
  private readonly units = new Map<string, ProjectUnit>();
  private readonly issuePipeline: IssueSpawnPipeline;
  private readonly sessionControl: PRSessionControl;
  private readonly spawner: WorkerSpawner;
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly onError: (err: unknown, where: string) => void;
  private running = false;

  constructor(private readonly options: GithubAutomationOptions) {
    this.enabled = options.enabled ?? true;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.onError =
      options.onError ??
      ((err, where) => console.error(`[agentskiss/wiring] error in ${where}:`, err));

    const base = new SessionManagerSpawner(options.sessions);
    // Auto-spawns also announce the worker on the hub (manual spawns do so
    // via the spawn endpoint; the pipeline bypasses it).
    this.spawner = {
      spawnWorker: async (projectId, issueNumber) => {
        const spawned = await base.spawnWorker(projectId, issueNumber);
        this.broadcast(
          { type: "worker.spawned", at: this.now().toISOString(), worker: workerSchema.parse(spawned.worker) },
          `spawn:${projectId}`,
        );
        return spawned;
      },
      listActiveWorkerIssueNumbers: (projectId) => base.listActiveWorkerIssueNumbers(projectId),
    };

    this.sessionControl = {
      listWorkers: (filter) => options.sessions.listWorkers(filter),
      getWorker: (workerId) => options.sessions.getWorker(workerId),
      updateWorkerStatus: (workerId, status, statusMessage) => {
        const worker = options.sessions.updateWorkerStatus(workerId, status, statusMessage);
        this.broadcast(
          {
            type: "worker.status.changed",
            at: this.now().toISOString(),
            projectId: worker.projectId,
            workerId: worker.id,
            status,
          },
          `worker-status:${workerId}`,
        );
        return worker;
      },
      sendKeys: (sessionId, keys, sendOptions) => options.sessions.sendKeys(sessionId, keys, sendOptions),
    };

    const projectSource: ProjectSource = {
      get: (projectId) => registeredProject(options.projects, projectId),
    };
    this.issuePipeline = new IssueSpawnPipeline({
      projects: projectSource,
      blockers: new RoutingBlockerResolver(options.projects, options.gh, this.onError),
      spawner: this.spawner,
      onError: (err) => this.onError(err, "issue-pipeline"),
    });

    this.issuePipeline.kanbanEvents.on((event) => {
      if (event.type !== "kanban.card.moved") return; // the issue pipeline only emits card moves
      const unit = this.units.get(event.projectId);
      if (unit === undefined) return;
      this.broadcast(event, `kanban:${event.projectId}`);
    });
  }

  // -- lifecycle -------------------------------------------------------------

  /**
   * Builds the per-project units, baselines the issue watchers (backlog
   * replay guard), then starts all poll loops and reconciles the PR
   * trackers. No-op when disabled or already running.
   */
  async start(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.rebuildUnits();
    this.running = true; // set before activation: handleWatcherEvent routes only while running
    await Promise.all(
      [...this.units.values()].map((unit) =>
        this.activateUnit(unit).catch((err) => this.onError(err, `activate:${unit.projectId}`)),
      ),
    );
  }

  /**
   * Stops all polling and pipelines. Idempotent. Shutdown ordering: call
   * this **first**, before the hub/server/terminal teardown, so no new
   * work starts while the rest of the daemon shuts down.
   */
  stop(): void {
    this.running = false;
    for (const unit of this.units.values()) this.stopUnit(unit);
    this.units.clear();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Project ids currently watched (empty when disabled/stopped). */
  get watchedProjectIds(): string[] {
    return [...this.units.keys()];
  }

  /**
   * Re-syncs the units with the current project list. Called by the project
   * service on register/update/delete (projects registered while the daemon
   * runs start being watched immediately); no-op when disabled.
   */
  resync(): void {
    if (!this.enabled) return;
    const removed = [...this.units.keys()].filter((id) => this.options.projects.get(id) === undefined);
    for (const id of removed) {
      const unit = this.units.get(id);
      if (unit !== undefined) this.stopUnit(unit);
      this.units.delete(id);
    }
    const created = this.rebuildUnits();
    for (const unit of created) {
      if (!this.running) continue;
      void this.activateUnit(unit);
    }
  }

  // -- event routing ---------------------------------------------------------

  /**
   * Routes one watcher event: issue events into the issue-spawn pipeline;
   * PR events into worker association + the PR loop (its card events are
   * broadcast on the hub). Also the entry point for synthetic events in
   * tests/ops. Events for unknown projects are ignored.
   */
  handleWatcherEvent(projectId: string, event: GithubWatcherEvent): void {
    if (!this.running) return; // stopped: watchers are halted; late events are dropped
    if (event.type === "issue.created" || event.type === "issue.assigned") {
      this.issuePipeline.handleEvent(event);
      // The event went through the spawn matrix (acceptance is the sync
      // contract; blocked/dup/cap decisions are the pipeline's), so the
      // cursor may advance past it — otherwise the next restart would
      // re-sweep issues the running daemon already handled (issue #50).
      const unit = this.units.get(projectId);
      if (unit !== undefined) unit.issueCursor.set(event.issue.number);
      return;
    }
    const unit = this.units.get(projectId);
    if (unit === undefined) return;
    this.associateWorkerPr(unit, event.pullRequest);
    for (const prEvent of unit.prPipeline.handleWatcherEvent(event)) {
      this.broadcastPrEvent(unit, prEvent);
    }
  }

  /**
   * Runs one PR-loop poll for a project (or all projects) and broadcasts
   * the produced card events. Test/ops hook — the running loop polls by
   * itself.
   */
  async pollPrPipeline(projectId?: string): Promise<void> {
    const targets = projectId === undefined ? [...this.units.values()] : [this.units.get(projectId)].filter(
      (unit): unit is ProjectUnit => unit !== undefined,
    );
    for (const unit of targets) {
      for (const prEvent of await unit.prPipeline.pollOnce()) {
        this.broadcastPrEvent(unit, prEvent);
      }
    }
  }

  /**
   * Runs one catch-up batch per project (or for one project) — the bounded
   * sweep of issues numbered above the persisted cursor (issue #50). Test/
   * ops hook: the running catch-up loop sweeps by itself, one batch per
   * poll tick. Returns after the batch is processed (spawn matrix included);
   * safe to call when no catch-up is pending (the fetch finds nothing above
   * the cursor and the batch is a no-op).
   */
  async pollCatchUp(projectId?: string): Promise<void> {
    const targets =
      projectId === undefined
        ? [...this.units.values()]
        : [this.units.get(projectId)].filter((unit): unit is ProjectUnit => unit !== undefined);
    for (const unit of targets) {
      if (unit.issueWatcher === null || unit.issueCursor.lastSeenIssueNumber === null) continue;
      if (await this.runCatchUpBatch(unit)) this.stopCatchUpLoop(unit);
    }
  }

  // -- internals -------------------------------------------------------------

  /**
   * Rebuilds the unit map to match the registered projects. Returns the
   * newly created units; unchanged units are left untouched (watchers keep
   * their snapshot state), changed ones are stopped and rebuilt.
   */
  private rebuildUnits(): ProjectUnit[] {
    const created: ProjectUnit[] = [];
    for (const project of this.options.projects.list()) {
      const existing = this.units.get(project.id);
      const configKey = `${project.repoUrl}|${project.settings.autoAgentUsername ?? ""}`;
      if (existing !== undefined) {
        if (existing.configKey === configKey) continue;
        this.stopUnit(existing);
        this.units.delete(project.id);
      }
      const unit = this.buildUnit(project.id, project.repoUrl, configKey);
      if (unit === undefined) continue;
      this.units.set(project.id, unit);
      created.push(unit);
    }
    return created;
  }

  private buildUnit(projectId: string, repoUrl: string, configKey: string): ProjectUnit | undefined {
    let repo: RepoRef;
    try {
      repo = parseRepoUrl(repoUrl);
    } catch (err) {
      this.onError(err, `watcher:${projectId}`);
      return undefined;
    }
    const gh = this.options.gh(repoUrl);
    const project = this.options.projects.get(projectId);
    if (project === undefined) return undefined;
    const emit = (event: GithubWatcherEvent): void => this.handleWatcherEvent(projectId, event);

    // Auto-spawn semantics: only watch issues created by / assigned to the
    // project's auto-agent username (PRD: "created or assigned to the
    // configured username"); no username ⇒ no issue watcher at all.
    const username = project.settings.autoAgentUsername;
    const issueWatcher =
      username === null
        ? null
        : new IssueWatcher({
            gh,
            projectId,
            repo,
            username,
            pollIntervalMs: this.pollIntervalMs,
            emit,
            onError: (err) => this.onError(err, `issue-watcher:${projectId}`),
          });
    const prWatcher = new PullRequestWatcher({
      gh,
      projectId,
      repo,
      pollIntervalMs: this.pollIntervalMs,
      emit,
      onError: (err) => this.onError(err, `pr-watcher:${projectId}`),
    });
    const tracker = new PRTracker(trackerFilePath(this.options.stateDir, projectId));
    const issueCursor = new IssueCursor(cursorFilePath(this.options.stateDir, projectId));
    const prPipeline = new PullRequestPipeline({
      gh,
      projectId,
      repo,
      sessions: this.sessionControl,
      tracker,
      emit: (event) => {
        const unit = this.units.get(projectId);
        if (unit !== undefined) this.broadcastPrEvent(unit, event);
      },
      pollIntervalMs: this.pollIntervalMs,
      onError: (err) => this.onError(err, `pr-pipeline:${projectId}`),
    });
    return {
      projectId,
      repoUrl,
      configKey,
      issueWatcher,
      issueCursor,
      catchUpLoop: null,
      prWatcher,
      tracker,
      prPipeline,
      lastColumns: new Map(),
    };
  }

  /**
   * Baselines a new unit's issue watcher (seeding the snapshot, discarding
   * the backlog replay), reconciles the issue cursor (first-start baseline
   * vs. bounded catch-up sweep — issue #50), then starts its loops. Safe
   * against concurrent stop().
   */
  private async activateUnit(unit: ProjectUnit): Promise<void> {
    if (unit.issueWatcher !== null) {
      try {
        await unit.issueWatcher.pollOnce(); // baseline: seed the snapshot, discard the backlog replay
        await this.reconcileIssueCursor(unit);
      } catch (err) {
        this.onError(err, `issue-watcher-baseline:${unit.projectId}`);
      }
    }
    if (!this.running || this.units.get(unit.projectId) !== unit) return;
    unit.issueWatcher?.start();
    unit.prWatcher.start();
    unit.prPipeline.start();
    for (const prEvent of unit.prPipeline.reconcile()) {
      this.broadcastPrEvent(unit, prEvent);
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
  private async reconcileIssueCursor(unit: ProjectUnit): Promise<void> {
    const highest = unit.issueWatcher?.highestSeenIssueNumber ?? null;
    const cursor = unit.issueCursor.lastSeenIssueNumber;
    if (cursor === null) {
      // First-ever start: baseline today's backlog instead of spawning it.
      if (highest !== null) unit.issueCursor.set(highest);
      return;
    }
    if (highest === null || highest <= cursor) return; // nothing to catch up
    try {
      if (!(await this.runCatchUpBatch(unit))) return;
    } catch (err) {
      this.onError(err, `issue-catchup:${unit.projectId}`);
    }
    this.startCatchUpLoop(unit); // more remain (or the batch failed): retry on the next poll tick
  }

  /** Starts (once) the per-poll loop that continues a catch-up sweep. */
  private startCatchUpLoop(unit: ProjectUnit): void {
    if (unit.catchUpLoop !== null) return;
    const loop = new PollLoop(
      async () => {
        if (await this.runCatchUpBatch(unit)) this.stopCatchUpLoop(unit);
      },
      this.pollIntervalMs,
      (err) => this.onError(err, `issue-catchup:${unit.projectId}`),
    );
    unit.catchUpLoop = loop;
    // First tick delayed: the sweep's first batch already ran at activation;
    // subsequent batches spread one per poll tick (issue #50).
    loop.start({ immediate: false });
  }

  private stopCatchUpLoop(unit: ProjectUnit): void {
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
  private async runCatchUpBatch(unit: ProjectUnit): Promise<boolean> {
    const cursor = unit.issueCursor.lastSeenIssueNumber;
    if (cursor === null) return true; // no cursor: nothing to sweep
    const records = await listIssuesCreatedAfter(
      this.options.gh(unit.repoUrl),
      unit.projectId,
      parseRepoUrl(unit.repoUrl),
      { afterNumber: cursor, first: CATCH_UP_BATCH_SIZE },
    );
    const username = this.options.projects.get(unit.projectId)?.settings.autoAgentUsername ?? null;
    let highest = cursor;
    for (const record of records) {
      // Same username rule as the live watcher (`IssueWatcher.matches`):
      // created by or assigned to the auto-agent username.
      if (username !== null && (record.author === username || record.assignees.includes(username))) {
        this.handleWatcherEvent(unit.projectId, {
          type: "issue.created",
          at: this.now().toISOString(),
          issue: record.issue,
        });
      }
      if (record.issue.number > highest) highest = record.issue.number;
    }
    // Advance only after the batch went through the spawn matrix, and only
    // while this unit is still the live one (a stopped unit re-sweeps).
    if (highest > cursor && this.running && this.units.get(unit.projectId) === unit) {
      unit.issueCursor.set(highest);
    }
    return records.length < CATCH_UP_BATCH_SIZE;
  }

  private stopUnit(unit: ProjectUnit): void {
    this.stopCatchUpLoop(unit);
    unit.issueWatcher?.stop();
    unit.prWatcher.stop();
    unit.prPipeline.stop();
  }

  /**
   * Associates a PR with its owning worker: if the PR's title/head branch
   * references the issue an unassociated, non-terminal worker is working
   * on, record the worker as the PR owner (`SessionManager.setWorkerPr`) —
   * the PR loop's tracker resolves ownership from the registry.
   */
  private associateWorkerPr(unit: ProjectUnit, pr: PullRequest): void {
    if (unit.tracker.get(pr.projectId, pr.number) !== undefined) return;
    const workers = this.options.sessions.listWorkers({ projectId: pr.projectId });
    if (workers.some((worker) => worker.prNumber === pr.number)) return;
    const refs = referencedIssueNumbers(`${pr.title} ${pr.headBranch}`);
    if (refs.size === 0) return;
    const owner = workers.find(
      (worker) =>
        worker.prNumber === null && worker.issueNumber !== 0 && refs.has(worker.issueNumber) && PR_OWNABLE_STATUSES.has(worker.status),
    );
    if (owner !== undefined) this.options.sessions.setWorkerPr(owner.id, pr.number);
  }

  private broadcastPrEvent(unit: ProjectUnit, event: PRPipelineEvent): void {
    // `kanban.pr.failed` always ships with a paired card upsert carrying
    // the same (last known) card state; the shared hub contract has no
    // failure column, so the card event alone keeps boards accurate.
    if (event.type !== "kanban.pr.card") return;
    const from = unit.lastColumns.get(event.card.id) ?? event.card.column;
    unit.lastColumns.set(event.card.id, event.card.column);
    this.broadcast(
      {
        type: "kanban.card.moved",
        at: event.at,
        projectId: event.card.projectId,
        cardId: event.card.id,
        from,
        to: event.card.column,
        card: event.card,
      },
      `kanban:${unit.projectId}`,
    );
  }

  private broadcast(event: KanbanUpdateEvent, where: string): void {
    try {
      this.options.hub.broadcast(event);
    } catch (err) {
      this.onError(err, where);
    }
  }
}
