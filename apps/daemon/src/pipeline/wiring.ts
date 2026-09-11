/**
 * Daemon wiring for the GitHub automation loop (issue #46).
 *
 * The watcher and pipeline modules (`github/watch.ts`, `pipeline/issues/`,
 * `pipeline/prs/`) are fully built libraries; this module is the wiring the
 * daemon entry point calls into. The moving parts live in their own
 * modules and are assembled here:
 *
 * - {@link ./env.js} — the `PD_WATCHER_*` environment knobs;
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

import path from "node:path";

import type { GhClient } from "../github/gh.js";
import { BlockedTicketStore } from "./issues/blocked-store.js";
import { IssueSpawnPipeline } from "./issues/pipeline.js";
import type { ProjectSource, WorkerSpawner } from "./issues/ports.js";
import type { AgentKindLookup } from "../sessions/agent-kinds.js";
import { countProjectOccupants } from "../sessions/occupancy.js";
import type { PRSessionControl } from "./prs/pipeline.js";
import type { WorkerPipelineSettings } from "./prs/settings.js";
import type { PRPipelineEvent } from "./prs/events.js";
import { DEFAULT_POLL_INTERVAL_MS, type GithubWatcherEvent } from "../github/watch.js";
import type { ProjectService } from "../api/projects.js";
import type { SessionManager } from "../sessions/manager.js";
import type { WsHub } from "../api/ws.js";
import type { PromptGate } from "../agent/prompt-gate.js";
import { KanbanBridge } from "./broadcast.js";
import { notifyOrchestrator, orchestratorReadyForMergeMessage, type OrchestratorPaneGuard } from "./orchestrator-notify.js";
import { CatchUpSweep } from "./catchup.js";
import { watcherOptionsFromEnv } from "./env.js";
import { associateWorkerPr } from "./issue-refs.js";
import { hubAnnouncedSpawner } from "./spawner.js";
import { buildPRSessionControl } from "./session-control.js";
import { buildUnit, registeredProject, RoutingBlockerResolver, type ProjectUnit } from "./unit-builder.js";
import { StallSweep, automationStallSweep } from "./issues/stall-sweep.js";
import { sessionReusePolicy } from "./issues/reuse.js";

export { watcherOptionsFromEnv };
export { CATCH_UP_BATCH_SIZE } from "./catchup.js";

export interface GithubAutomationOptions {
  projects: ProjectService;
  sessions: SessionManager;
  hub: WsHub;
  /** GhClient factory, keyed by repo URL (the daemon context's factory). */
  gh: (repoUrl: string) => GhClient;
  /** Daemon state dir (PR tracker + blocked-ticket persistence live under it). */
  stateDir: string;
  /**
   * Worker-pipeline toggles (issue #106), read fresh on every pipeline
   * decision so a toggle lands without a daemon restart. Default: all ON.
   */
  workerSettings?: () => WorkerPipelineSettings;
  /**
   * Review account (issue #407), read fresh. `reviewAccountToken`: set =
   * reviewer panes run `gh` as that second GitHub account (real `gh pr
   * review` submissions on primary-account PRs) and the PR loop's
   * review-based triggers run; null = single-account mode (no review cycle
   * at all). `reviewAccountUsername` is the second account's login — the
   * identity the PR-assignment leg (#408 lifecycle) and review-user-keyed
   * triggers key off; issue-assignment worker spawning (#416) does NOT key
   * off it — any assignee triggers a worker. Both-or-neither (issue #424):
   * the settings store rejects one without the other, and the unit builder
   * gates the review cycle on BOTH being set.
   */
  reviewAccountToken?: () => string | null;
  reviewAccountUsername?: () => string | null;
  /** Pi auth readiness for review-agent prompt gating (issue #107). Required (issue #424 F8) — the daemon context always provides it. */
  piReady: () => Promise<boolean>;
  /** Prompt gate (issue #56) holding review prompts until pi is ready; the stall sweep reads its prompt-in-flight view (issue #467). Required (issue #424 F8). */
  promptGate: Pick<PromptGate, "queue" | "hasPendingWorker">;
  /**
   * Agent-kind registry (v2, issue #330): consulted by the session
   * control's occupancy count so workerLike kind sessions gate the
   * review-agent spawn cap exactly like the other spawn paths (issue #393).
   */
  agentKinds: AgentKindLookup;
  /**
   * Pane-delivery guard for the orchestrator notification (issue #500):
   * confirms the orchestrator pane runs the agent persona before the
   * ready-for-merge text is typed into it — a bare-shell pane is
   * re-bootstrapped first, and an unrecoverable pane skips the delivery
   * loudly (the text is never typed into a shell). The daemon context
   * supplies the orchestrator bootstrap.
   */
  orchestratorGuard: OrchestratorPaneGuard;
  /** Master switch. Default: resolved from the environment (on). */
  enabled?: boolean;
  /** Poll interval for watchers and the PR loop. Default: 30s or env. */
  pollIntervalMs?: number;
  /** Stall-sweep idle window in ms (issue #467). Default: 15 min. */
  stallIdleMs?: number;
  /** Stall-sweep bound: re-prompts per worker before it is failed (issue #467). Default: 2. */
  stallMaxReprompts?: number;
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
  private readonly stallSweep: StallSweep;
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly onError: (err: unknown, where: string) => void;
  private running = false;
  private stallTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: GithubAutomationOptions) {
    this.enabled = options.enabled ?? true;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.onError =
      options.onError ??
      ((err, where) => console.error(`[pideck/wiring] error in ${where}:`, err));
    this.bridge = new KanbanBridge(options.hub, this.onError);
    this.catchUp = new CatchUpSweep({
      gh: options.gh,
      handleWatcherEvent: (projectId, event) => this.handleWatcherEvent(projectId, event),
      isRunning: () => this.running,
      isLiveUnit: (unit) => this.units.get(unit.projectId) === unit,
      pollIntervalMs: this.pollIntervalMs,
      now: this.now,
      onError: this.onError,
    });

    this.spawner = hubAnnouncedSpawner(options, this.bridge, this.now, this.onError);

    // Issue #467: the deterministic stall backstop for issue workers — the
    // one loop that notices a silently ended turn (no PR, no prompt in
    // flight, idle past the window) and re-prompts, bounded.
    this.stallSweep = automationStallSweep(options.sessions, (workerId, status, statusMessage) => this.sessionControl.updateWorkerStatus(workerId, status, statusMessage), (workerId) => options.promptGate.hasPendingWorker(workerId), {
      ...(options.stallIdleMs !== undefined ? { stallIdleMs: options.stallIdleMs } : {}),
      ...(options.stallMaxReprompts !== undefined ? { maxReprompts: options.stallMaxReprompts } : {}),
      now: this.now,
      onError: this.onError,
    });

    this.sessionControl = buildPRSessionControl({
      sessions: options.sessions,
      bridge: this.bridge,
      agentKinds: options.agentKinds,
      reviewAccountToken: () => options.reviewAccountToken?.() ?? null,
      piReady: options.piReady,
      promptGate: options.promptGate,
      now: this.now,
      onError: this.onError,
    });

    const projectSource: ProjectSource = {
      get: (projectId) => registeredProject(options.projects, projectId),
    };
    this.issuePipeline = new IssueSpawnPipeline({
      projects: projectSource,
      blockers: new RoutingBlockerResolver(options.projects, options.gh, this.onError),
      spawner: this.spawner,
      // Issue #427: the blocked-ticket map persists next to the PR tracker
      // files, so a restart no longer strands blocked tickets (the watcher
      // re-baselines and the catch-up sweep never revisits issues at/below
      // the cursor — the merge-driven sweep is the only recovery path).
      blockedStore: new BlockedTicketStore(path.join(options.stateDir, "blocked-tickets.json")),
      // Issue #408: the unblock sweep gates capped projects' spawns with the
      // SAME occupancy predicate (#393) as every other spawn path — active
      // workers + live workerLike kind sessions.
      countOccupants: (projectId) => countProjectOccupants(options.sessions, options.agentKinds, projectId),
      // Issue #471: idle same-lane worker reuse — the deterministic spawn
      // pipeline consults the reuse policy before a fresh spawn (no lane on
      // a spawn ⇒ fresh spawn, the deterministic default). The threshold is
      // the workerReuseContextThreshold setting, read fresh per decision.
      reusePolicy: sessionReusePolicy(options.sessions),
      workerSettings: options.workerSettings,
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
    // Issue #467: the stall sweep rides the automation's poll cadence.
    this.stallTimer = setInterval(() => {
      void this.pollStallSweep();
    }, this.pollIntervalMs);
    this.stallTimer.unref?.();
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
    if (this.stallTimer !== null) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
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
    for (const id of removed) this.stopProject(id);
    const created = this.rebuildUnits();
    for (const unit of created) {
      if (!this.running) continue;
      void this.activateUnit(unit);
    }
  }

  /**
   * Stops one project's watching + pipelines (issue #172 project delete's
   * first teardown step, and the per-project half of {@link resync}).
   * Idempotent on projects that are not currently watched.
   */
  stopProject(projectId: string): void {
    const unit = this.units.get(projectId);
    if (unit === undefined) return;
    this.stopUnit(unit);
    this.units.delete(projectId);
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
    if (
      event.type === "issue.created" ||
      event.type === "issue.assigned" ||
      event.type === "issue.unassigned" ||
      event.type === "issue.closed"
    ) {
      this.issuePipeline.handleEvent(event);
      // Assignment events went through the spawn matrix (acceptance is the
      // sync contract; blocked/dup/cap decisions are the pipeline's), so the
      // cursor may advance past them — otherwise the next restart would
      // re-sweep issues the running daemon already handled (issue #50).
      if (event.type === "issue.assigned") {
        const unit = this.units.get(projectId);
        if (unit !== undefined) unit.issueCursor.set(event.issue.number);
      }
      return;
    }
    const unit = this.units.get(projectId);
    if (unit === undefined) return;
    associateWorkerPr(
      unit.tracker,
      this.options.sessions.listWorkers({ projectId: event.pullRequest.projectId }),
      {
        setWorkerPr: (workerId, prNumber) => this.options.sessions.setWorkerPr(workerId, prNumber),
        // Issue #466/#470: the re-watch verification can move a PR to the
        // worker its head branch actually names (removing it from the old
        // owner's list — the old owner keeps its other PRs).
        clearWorkerPr: (workerId, prNumber) => this.options.sessions.clearWorkerPr(workerId, prNumber),
      },
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

  /**
   * Runs one stall-sweep pass (issue #467) — the deterministic backstop
   * that re-prompts silently-stalled issue workers. Test/ops hook: the
   * running automation sweeps on its own poll timer.
   */
  async pollStallSweep(): Promise<void> {
    if (!this.running) return; // stopped: no sweeps
    await this.stallSweep.sweep().catch((err) => this.onError(err, "stall-sweep"));
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
      const configKey = project.repoUrl;
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
          reviewAccountToken: this.options.reviewAccountToken,
          reviewAccountUsername: this.options.reviewAccountUsername,
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
    try {
      await unit.issueWatcher.pollOnce(); // baseline: seed the snapshot, discard the backlog replay
      await this.catchUp.reconcileAfterBaseline(unit);
    } catch (err) {
      this.onError(err, `issue-watcher-baseline:${unit.projectId}`);
    }
    if (!this.running || this.units.get(unit.projectId) !== unit) return;
    unit.issueWatcher.start();
    unit.prWatcher.start();
    unit.prPipeline.start();
    for (const prEvent of unit.prPipeline.reconcile()) {
      this.broadcastPrEvent(unit.projectId, prEvent);
    }
  }

  private stopUnit(unit: ProjectUnit): void {
    this.catchUp.stopLoop(unit);
    this.bridge.forget(unit.projectId);
    unit.issueWatcher.stop();
    unit.prWatcher.stop();
    unit.prPipeline.stop();
  }

  private broadcastPrEvent(projectId: string, event: PRPipelineEvent): void {
    this.bridge.broadcastPrEvent(projectId, event);
    // Issue #408 (flow step 8): a merge closes the PR's "Closes"-linked issues —
    // re-evaluate the project's recorded blocked tickets and spawn workers for
    // the ones that just unblocked (occupancy + dedupe = no running conflicts).
    if (event.type === "notification.pr.merged") void this.issuePipeline.sweepUnblocked(projectId);
    // Issue #490: an approved PR's orchestrator notification must reach the
    // orchestrator deterministically — the hub broadcast only reaches webapps,
    // so the wiring also types the notification into the orchestrator's pane
    // (its notification path, `pideck send` parity). Issue #500: the pane is
    // only messaged once the guard confirms it runs the agent persona — a
    // bare-shell orchestrator pane is re-bootstrapped first, and delivery is
    // skipped loudly when recovery cannot produce an input-ready pane (never
    // typed into a shell). The pipeline fires the event exactly once per
    // approved round, so the pane is messaged once per round too. Failures
    // are logged; the loop keeps running.
    if (event.type === "notification.pr.ready_for_merge") {
      void notifyOrchestrator(
        this.options.sessions,
        this.options.orchestratorGuard,
        event.projectId,
        orchestratorReadyForMergeMessage(event.prNumber, event.title),
      ).catch((err) => this.onError(err, `orchestrator-notify:${event.projectId}`));
    }
  }
}
