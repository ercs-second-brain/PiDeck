/**
 * Daemon context: assembles the API-layer services (project store/service,
 * settings, kanban, diffs, session manager, WS hub) with injectable
 * overrides so tests can run without network, tmux, or the real state dir.
 */

import os from "node:os";
import path from "node:path";

import type { Project, Worker } from "@agentskiss/shared";

import { GhClient } from "../github/index.js";
import type { GitRunner } from "../github/repos.js";
import { ProjectLayout } from "../sessions/layout.js";
import { SessionManager } from "../sessions/manager.js";
import { SessionRegistry } from "../sessions/registry.js";
import { Tmux } from "../sessions/tmux.js";

import { DiffService } from "./diffs.js";
import { KanbanService } from "./kanban.js";
import { PullListingService } from "./pull-listing.js";
import { ProjectService, ProjectStore } from "./projects.js";
import { SettingsStore } from "./settings.js";
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
  hub: WsHub;
  /** Shared tmux runner (the terminal bridge streams through the same one). */
  tmux: Tmux;
  /** Shared session registry (the terminal bridge resolves sessions through it). */
  registry: SessionRegistry;
  /** Injectable clock (ISO timestamps for events). */
  now: () => Date;
}

export interface DaemonContextOptions {
  /** Daemon state dir (default: `AGENTSKISS_HOME` or `~/.agentskiss`). */
  stateDir?: string;
  /** Override the GhClient factory (tests). */
  gh?: (repoUrl: string) => GhClient;
  /** Override the git runner used by project registration (tests). */
  git?: GitRunner;
  /** Override the tmux runner (tests use `FakeTmuxRunner`). */
  tmux?: Tmux;
  /** Override the registry (tests). */
  registry?: SessionRegistry;
}

/** Resolves the daemon state dir honoring `AGENTSKISS_HOME`. */
export function resolveStateDir(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const fromEnv = process.env["AGENTSKISS_HOME"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return path.join(os.homedir(), ".agentskiss");
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
  const projects = new ProjectService({
    store: projectStore,
    layout,
    // agent/README.md: daemon-wide auto-agent username + worker concurrency
    // are the defaults seeded into newly registered projects.
    defaultSettings: () => ({
      autoAgentUsername: settings.get().autoAgentUsername,
      workerConcurrency: settings.get().defaultWorkerConcurrency,
    }),
    ...(options.git !== undefined ? { git: options.git } : {}),
    gh,
  });
  const hub = new WsHub();

  const pullListing = new PullListingService({ gh });
  const kanban = new KanbanService({
    gh,
    listWorkers: () => sessions.listWorkers(),
    // Batched + cached PR listing (issue #40) — the API layer shares the
    // GitHub token with watchers/pipelines, so it must not burn O(PR) calls.
    listPullRequests: (project) => pullListing.list(project.id, project.repoUrl),
  });
  const diffs = new DiffService({ gh, pullListing: (projectId, repoUrl) => pullListing.list(projectId, repoUrl) });

  return {
    projects,
    projectStore,
    settings,
    kanban,
    diffs,
    pullListing,
    sessions,
    hub,
    tmux,
    registry,
    now: () => new Date(),
  };
}

/** Live (non-terminal) workers of a project — helper for pipelines/tests. */
export function activeWorkers(services: DaemonServices, projectId: string): Worker[] {
  return services.sessions.listWorkers({ projectId }).filter((worker) => worker.status !== "done" && worker.status !== "failed" && worker.status !== "stopped");
}

export type { Project };
