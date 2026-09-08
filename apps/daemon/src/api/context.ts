/**
 * Daemon context: assembles the API-layer services (project store/service,
 * settings, kanban, diffs, session manager, WS hub) with injectable
 * overrides so tests can run without network, tmux, or the real state dir.
 */

import path from "node:path";

import type { Project } from "@pideck/shared";

import { PiAuthProbe, type PiRunner } from "../agent/pi-auth.js";
import { PromptGate } from "../agent/prompt-gate.js";
import { GhClient } from "../github/index.js";
import type { GhRunner } from "../github/gh.js";
import type { GitRunner } from "../github/repos.js";
import { GithubAutomation, watcherOptionsFromEnv } from "../pipeline/wiring.js";
import { OrchestratorBootstrap } from "../orchestrator/bootstrap.js";
import { ProjectLayout, defaultStateDir } from "../sessions/layout.js";
import { SessionManager } from "../sessions/manager.js";
import { SessionRegistry } from "../sessions/registry.js";
import { Tmux } from "../sessions/tmux.js";

import { DiffService } from "./diffs.js";
import { KanbanService } from "./kanban.js";
import { PullListingService } from "./pull-listing.js";
import { ProjectService, ProjectStore } from "./projects.js";
import { RuntimeStats } from "./runtime-stats.js";
import { SettingsStore } from "./settings.js";
import { UpdateChecker, type UpdateSpawn } from "./update.js";
import { WsHub } from "./ws.js";

export interface DaemonServices {
  projects: ProjectService;
  projectStore: ProjectStore;
  settings: SettingsStore;
  kanban: KanbanService;
  diffs: DiffService;
  /** Batched + TTL-cached open-PR listing shared by kanban/diffs (issue #40). */
  pullListing: PullListingService;
  sessions: SessionManager;
  /**
   * Orchestrator bootstrap (issue #12): ensures every registered project's
   * orchestrator pane runs pi with the persona — driven at daemon startup
   * and after each project registration (issue #166).
   */
  orchestratorBootstrap: OrchestratorBootstrap;
  hub: WsHub;
  /** Shared tmux runner (the terminal bridge streams through the same one). */
  tmux: Tmux;
  /** Shared session registry (the terminal bridge resolves sessions through it). */
  registry: SessionRegistry;
  /**
   * GitHub watcher + issue/PR pipeline wiring (issue #46). Constructed but
   * NOT started: the daemon entry point calls `automation.start()` after
   * session reconciliation and `stop()` first on shutdown.
   */
  automation: GithubAutomation;
  /** Self-update check: local source vs upstream via gh (issue #55, `GET /api/update`). */
  update: UpdateChecker;
  /**
   * pi auth readiness probe (issue #57): backs `GET /api/pi-auth`, the
   * `/api/status` pi fields, and the spawn readiness gate (issue #56).
   */
  piAuth: PiAuthProbe;
  /**
   * Initial-prompt readiness gate (issue #56): holds prompts for spawns
   * made before pi auth is ready and delivers them once it is.
   */
  promptGate: PromptGate;
  /** Injectable clock (ISO timestamps for events). */
  now: () => Date;
  /**
   * Event-loop lag + memory + uptime sampler (issue #100): surfaced in
   * `GET /api/status`; stopped on daemon shutdown.
   */
  runtimeStats: RuntimeStats;
}

export interface DaemonContextOptions {
  /** Daemon state dir (default: `PD_HOME` or `~/.pideck`). */
  stateDir?: string;
  /** Override the GhClient factory (tests). */
  gh?: (repoUrl: string) => GhClient;
  /** Override the git runner used by project registration (tests). */
  git?: GitRunner;
  /** Override the tmux runner (tests use `FakeTmuxRunner`). */
  tmux?: Tmux;
  /** Override the registry (tests). */
  registry?: SessionRegistry;
  /** Disable the GitHub watcher/pipeline loop (tests; env: `PD_WATCHER_ENABLED=0`). */
  watcherEnabled?: boolean;
  /** Watcher/PR-loop poll interval in ms (tests; env: `PD_WATCHER_POLL_INTERVAL_MS`). */
  watcherPollIntervalMs?: number;
  /** Override the gh runner used by the update checker (tests; issue #55). */
  updateGh?: GhRunner;
  /** Override the git runner used by the update checker (tests; issue #55). */
  updateGit?: GitRunner;
  /** Override the detached spawner used by `update.apply()` (tests; issue #76). */
  updateSpawn?: UpdateSpawn;
  /** Explicit upstream repo URL for the update checker (tests; env override). */
  updateRepoUrl?: string;
  /** Explicit upstream ref for the update checker (tests; env override). */
  updateRepoRef?: string;
  /** Override the pi CLI runner used by the pi auth probe (tests). */
  piRunner?: PiRunner;
  /** Force the pi-auth readiness verdict without probing (tests). */
  piReady?: boolean;
  /** Prompt-gate poll interval in ms (tests; `0` = manual delivery only). */
  promptGatePollIntervalMs?: number;
  /** pi-auth probe result TTL in ms (tests; `0` disables caching). */
  piAuthTtlMs?: number;
}

/** Resolves the daemon state dir honoring `PD_HOME`. */
export function resolveStateDir(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return defaultStateDir();
}

export function createDaemonContext(options: DaemonContextOptions = {}): DaemonServices {
  const stateDir = resolveStateDir(options.stateDir);
  const layout = new ProjectLayout(stateDir);
  const registry = options.registry ?? new SessionRegistry(layout.sessionsFilePath());
  const tmux = options.tmux ?? new Tmux();
  const sessions = new SessionManager({ tmux, registry, layout });

  const gh = options.gh ?? ((_repoUrl: string) => new GhClient());
  const projectStore = new ProjectStore(stateDir);
  const settings = new SettingsStore(stateDir);
  // Forward-declared so the project service's change hook can reach the
  // automation constructed below it (register/update/delete → resync).
  const automationRef: { current?: GithubAutomation } = {};
  const projects = new ProjectService({
    store: projectStore,
    layout,
    // agent/README.md: daemon-wide defaults seed new projects.
    defaultSettings: () => ({
      autoAgentUsername: settings.get().autoAgentUsername,
      workerConcurrency: settings.get().defaultWorkerConcurrency,
    }),
    // Mid-run register/update/delete → watcher/pipeline resync (issue #46).
    onChange: () => automationRef.current?.resync(),
    ...(options.git !== undefined ? { git: options.git } : {}),
    gh,
  });
  const hub = new WsHub();

  // Orchestrator bootstrap (#12/#166): shared by the startup sweep and the registration handler.
  const orchestratorBootstrap = new OrchestratorBootstrap({ sessions, tmux, projects, layout });

  // pi auth readiness (issue #57) + worker initial-prompt gate (issue #56): the
  // gate polls through the same probe so queued prompts deliver when ready.
  const piAuth = new PiAuthProbe({
    ...(options.piRunner !== undefined ? { run: options.piRunner } : {}),
    ...(options.piReady !== undefined ? { readyOverride: options.piReady } : {}),
    ...(options.piAuthTtlMs !== undefined ? { ttlMs: options.piAuthTtlMs } : {}),
  });
  const promptGate = new PromptGate({
    sendKeys: (sessionId, keys, sendOptions) => sessions.sendKeys(sessionId, keys, sendOptions),
    getWorker: (workerId) => sessions.getWorker(workerId),
    updateWorkerStatus: (workerId, status, statusMessage) => sessions.updateWorkerStatus(workerId, status, statusMessage),
    isReady: async () => (await piAuth.payload()).ready,
    ...(options.promptGatePollIntervalMs !== undefined ? { pollIntervalMs: options.promptGatePollIntervalMs } : {}),
  });

  const pullListing = new PullListingService({ gh });
  const kanban = new KanbanService({
    gh,
    listWorkers: () => sessions.listWorkers(),
    // Batched + cached PR listing (issue #40) — the API layer shares the
    // GitHub token with watchers/pipelines, so it must not burn O(PR) calls.
    listPullRequests: (project) => pullListing.list(project.id, project.repoUrl),
  });
  const diffs = new DiffService({ gh, pullListing: (projectId, repoUrl) => pullListing.list(projectId, repoUrl) });

  const watcherOptions = watcherOptionsFromEnv(process.env, {
    ...(options.watcherEnabled !== undefined ? { enabled: options.watcherEnabled } : {}),
    ...(options.watcherPollIntervalMs !== undefined ? { pollIntervalMs: options.watcherPollIntervalMs } : {}),
  });
  const automation = new GithubAutomation({
    projects,
    sessions,
    hub,
    gh,
    stateDir,
    // Issues #106/#107: toggles and the pi-readiness gate are read fresh per decision.
    workerSettings: () => settings.get(),
    piReady: () => piAuth.payload().then((payload) => payload.ready),
    promptGate,
    ...watcherOptions,
  });
  automationRef.current = automation;

  // Self-update check (issue #55): the installed checkout is either the
  // service-configured PD_SRC or the installer's <stateDir>/src;
  // upstream repo/ref come from the installer's config.json unless overridden.
  const update = new UpdateChecker({
    srcDir: process.env["PD_SRC"] ?? path.join(stateDir, "src"),
    stateDir,
    ...(options.updateRepoUrl !== undefined ? { repoUrl: options.updateRepoUrl } : {}),
    ...(options.updateRepoRef !== undefined ? { repoRef: options.updateRepoRef } : {}),
    ...(options.updateGh !== undefined ? { gh: options.updateGh } : {}),
    ...(options.updateGit !== undefined ? { git: options.updateGit } : {}),
    ...(options.updateSpawn !== undefined ? { spawn: options.updateSpawn } : {}),
  });

  return {
    projects,
    projectStore,
    settings,
    kanban,
    diffs,
    pullListing,
    sessions,
    orchestratorBootstrap,
    hub,
    tmux,
    registry,
    automation,
    update,
    piAuth,
    promptGate,
    now: () => new Date(),
    runtimeStats: new RuntimeStats(),
  };
}

export type { Project };
