/**
 * Daemon wiring for the GitHub automation loop (issue #46).
 *
 * The watcher and pipeline modules (`github/watch.ts`, `pipeline/issues/`,
 * `pipeline/prs/`) are fully built libraries; this module is the wiring the
 * daemon entry point calls into. The moving parts live in their own
 * modules and are assembled here:
 *
 * - {@link ./env.js} — the `AGENTSKISS_WATCHER_*` environment knobs;
 * - {@link ./unit-builder.ts} — the per-project unit (watchers +
 *   pipelines + tracker + cursor, issue #46);
 * - {@link ./catchup.ts} — the bounded catch-up sweep of downtime-created
 *   issues, keyed by the persisted issue cursor (issue #50);
 * - {@link ./issue-refs.ts} — worker↔PR association by issue reference;
 * - {@link ./broadcast.ts} — the kanban broadcast bridge onto the WS hub.
 *
 * Start ordering (daemon entry point): session reconciliation →
 * orchestrator bootstrap → `automation.start()`. `start()` baselines each
 * new issue watcher (seeding the snapshot, discarding its events) so the
 * live watcher only spawns for issues that appear or change *while it is
 * running*; issues created while the daemon was down are handled by the
 * catch-up sweep (see `pipeline/catchup.ts`).
 *
 * Shutdown ordering: `stop()` first (halts all polling and pipelines), then
 * the rest of the daemon tears down.
 */

import { workerSchema } from "@agentskiss/shared";

import type { GhClient } from "../github/gh.js";
import { IssueSpawnPipeline } from "./issues/pipeline.js";
import type { ProjectSource, WorkerSpawner } from "./issues/ports.js";
import { SessionManagerSpawner } from "./issues/ports.js";
import type { PRSessionControl } from "./prs/pipeline.js";
import type { WorkerPipelineSettings } from "./prs/settings.js";
import type { PRPipelineEvent } from "./prs/events.js";
import { DEFAULT_POLL_INTERVAL_MS, type GithubWatcherEvent } from "../github/watch.js";
import type { ProjectService } from "../api/projects.js";
import type { SessionManager } from "../sessions/manager.js";
import type { WsHub } from "../api/ws.js";
import type { PromptGate } from "../agent/prompt-gate.js";
import { KanbanBridge } from "./broadcast.js";
import { CatchUpSweep } from "./catchup.js";
import { watcherOptionsFromEnv } from "./env.js";
import { associateWorkerPr } from "./issue-refs.js";
import { buildUnit, registeredProject, RoutingBlockerResolver, type ProjectUnit } from "./unit-builder.js";
import { spawnReviewAgent as spawnReviewAgentImpl } from "./prs/review-spawn.js";

export { watcherOptionsFromEnv };
export { CATCH_UP_BATCH_SIZE } from "./catchup.js";

export interface GithubAutomationOptions {
  projects: ProjectService;
  sessions: SessionManager;
  hub: WsHub;
  /** GhClient factory, keyed by repo URL (the daemon context's factory). */
  gh: (repoUrl: string) => GhClient;
  /** Daemon state dir (PR tracker persistence lives under `<stateDir>/pr-tracker/`). */
  stateDir: string;
  /**
   * Worker-pipeline toggles (issue #106), read fresh on every pipeline
   * decision so a toggle lands without a daemon restart. Default: all ON.
   */
  workerSettings?: () => WorkerPipelineSettings;
  /** Pi auth readiness for review-agent prompt gating (issue #107). */
  piReady?: () => Promise<boolean>;
  /** Prompt gate (issue #56) holding review prompts until pi is ready. */
  promptGate?: Pick<PromptGate, "queue">;
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
  private readonly bridge: KanbanBridge;
  private readonly catchUp: CatchUpSweep;
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
    this.bridge = new KanbanBridge(options.hub, this.onError);
    this.catchUp = new CatchUpSweep({
      gh: options.gh,
      getProject: (projectId) => options.projects.get(projectId),
      handleWatcherEvent: (projectId, event) => this.handleWatcherEvent(projectId, event),
      isRunning: () => this.running,
      isLiveUnit: (unit) => this.units.get(unit.projectId) === unit,
      pollIntervalMs: this.pollIntervalMs,
      now: this.now,
      onError: this.onError,
    });

    const base = new SessionManagerSpawner(options.sessions);
    // Auto-spawns also announce the worker on the hub (manual spawns do so
    // via the spawn endpoint; the pipeline bypasses it).
    this.spawner = {
      spawnWorker: async (projectId, issueNumber) => {
        const spawned = await base.spawnWorker(projectId, issueNumber);
        this.bridge.broadcast(
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
        this.bridge.broadcast(
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
      // Issue #106: terminate-on-merge archives the owning worker (kills its
      // pane); the wiring announces the terminal status like a manual terminate.
      archiveWorker: async (workerId, message) => {
        const worker = await options.sessions.archiveWorker(workerId, message);
        if (worker !== null) {
          this.bridge.broadcast(
            {
              type: "worker.status.changed",
              at: this.now().toISOString(),
              projectId: worker.projectId,
              workerId: worker.id,
              status: worker.status,
            },
            `worker-status:${workerId}`,
          );
        }
        return worker;
      },
      // Issue #107: the auto review agent spawn path — reviewer kind nested
      // under the PR-authoring worker, spawn announced, prompt gated on pi
      // readiness like manual spawns (issue #56 parity).
      spawnReviewAgent: (projectId, request) =>
        spawnReviewAgentImpl(projectId, request, {
          sessions: options.sessions,
          broadcastSpawned: (worker) => {
            this.bridge.broadcast(
              { type: "worker.spawned", at: this.now().toISOString(), worker: workerSchema.parse(worker) },
              `spawn:${projectId}`,
            );
          },
          ...(options.piReady !== undefined ? { piReady: options.piReady } : {}),
          ...(options.promptGate !== undefined ? { promptGate: options.promptGate } : {}),
          onError: (err) => this.onError(err, `review-spawn:${projectId}`),
        }),
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
      if (this.units.get(event.projectId) === undefined) return;
      this.bridge.broadcast(event, `kanban:${event.projectId}`);
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
    associateWorkerPr(
      unit.tracker,
      this.options.sessions.listWorkers({ projectId: event.pullRequest.projectId }),
      (workerId, prNumber) => this.options.sessions.setWorkerPr(workerId, prNumber),
      event.pullRequest,
    );
    for (const prEvent of unit.prPipeline.handleWatcherEvent(event)) {
      this.broadcastPrEvent(projectId, prEvent);
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
        this.broadcastPrEvent(unit.projectId, prEvent);
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
    await this.catchUp.pollBatch(targets);
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
      const unit = buildUnit(
        {
          gh: this.options.gh,
          projects: this.options.projects,
          stateDir: this.options.stateDir,
          pollIntervalMs: this.pollIntervalMs,
          sessionControl: this.sessionControl,
          workerSettings: this.options.workerSettings,
          onWatcherEvent: (projectId, event) => this.handleWatcherEvent(projectId, event),
          onPrEvent: (projectId, event) => {
            if (this.units.get(projectId) !== undefined) this.broadcastPrEvent(projectId, event);
          },
          onError: this.onError,
        },
        project.id,
        project.repoUrl,
        configKey,
      );
      if (unit === undefined) continue;
      this.units.set(project.id, unit);
      created.push(unit);
    }
    return created;
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
        await this.catchUp.reconcileAfterBaseline(unit);
      } catch (err) {
        this.onError(err, `issue-watcher-baseline:${unit.projectId}`);
      }
    }
    if (!this.running || this.units.get(unit.projectId) !== unit) return;
    unit.issueWatcher?.start();
    unit.prWatcher.start();
    unit.prPipeline.start();
    for (const prEvent of unit.prPipeline.reconcile()) {
      this.broadcastPrEvent(unit.projectId, prEvent);
    }
  }

  private stopUnit(unit: ProjectUnit): void {
    this.catchUp.stopLoop(unit);
    this.bridge.forget(unit.projectId);
    unit.issueWatcher?.stop();
    unit.prWatcher.stop();
    unit.prPipeline.stop();
  }

  private broadcastPrEvent(projectId: string, event: PRPipelineEvent): void {
    this.bridge.broadcastPrEvent(projectId, event);
  }
}
