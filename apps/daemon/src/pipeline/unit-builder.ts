/**
 * Per-project automation unit builder (issue #46 wiring, extracted).
 *
 * A *unit* is everything one registered project needs to participate in
 * the GitHub automation loop:
 *
 * - an {@link IssueWatcher} (only when the project has auto-spawn enabled,
 *   i.e. `settings.autoAgentUsername !== null`) feeding the shared
 *   {@link IssueSpawnPipeline};
 * - a {@link PullRequestWatcher} feeding the project's
 *   {@link PullRequestPipeline};
 * - a persisted {@link PRTracker} (`<stateDir>/pr-tracker/<projectId>.json`)
 *   and {@link IssueCursor} (`<stateDir>/issue-cursor/<projectId>.json`), so
 *   the PR loop and the catch-up sweep survive daemon restarts.
 *
 * Units are identity-keyed by a `configKey` (repo URL + auto-agent
 * username): a changed key means the unit is stopped and rebuilt.
 */

import path from "node:path";

import type { Issue, IssueBlocker, KanbanColumn } from "@pideck/shared";

import type { GhClient, RepoRef } from "../github/gh.js";
import { formatRepoRef, parseRepoUrl } from "../github/gh.js";
import { IssueCursor } from "./issues/cursor.js";
import { GhBlockerResolver } from "./issues/blockers.js";
import type { BlockerResolver, RegisteredProject } from "./issues/ports.js";
import type { ProjectService } from "../api/projects.js";
import { PullRequestPipeline, type PRSessionControl } from "./prs/pipeline.js";
import type { WorkerPipelineSettings } from "./prs/settings.js";
import { PRTracker } from "./prs/tracker.js";
import { IssueWatcher, PollLoop, PullRequestWatcher, type GithubWatcherEvent } from "../github/watch.js";
import type { PRPipelineEvent } from "./prs/events.js";

/** Project ids are slugified (`api/projects.ts`), so they are filename-safe. */
function trackerFilePath(stateDir: string, projectId: string): string {
  return path.join(stateDir, "pr-tracker", `${projectId}.json`);
}

/** Issue-cursor file for a project (`<stateDir>/issue-cursor/<projectId>.json`). */
function cursorFilePath(stateDir: string, projectId: string): string {
  return path.join(stateDir, "issue-cursor", `${projectId}.json`);
}

/** The registered project for an id, with its parsed repo ref. */
export function registeredProject(projects: ProjectService, projectId: string): RegisteredProject | undefined {
  const project = projects.get(projectId);
  if (project === undefined) return undefined;
  try {
    return { project, repo: parseRepoUrl(project.repoUrl) };
  } catch {
    return undefined; // unparseable repoUrl: not watchable
  }
}

/**
 * Blocker resolver that routes to the right project's `GhClient` (the gh
 * factory is keyed by repo URL; the issue pipeline is project-agnostic).
 */
export class RoutingBlockerResolver implements BlockerResolver {
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

/** One registered project's slice of the automation loop. */
export interface ProjectUnit {
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

/** Everything {@link buildUnit} needs from the daemon context. */
export interface UnitBuilderDeps {
  gh: (repoUrl: string) => GhClient;
  projects: ProjectService;
  /** Daemon state dir (PR tracker + issue cursor live under it). */
  stateDir: string;
  pollIntervalMs: number;
  sessionControl: PRSessionControl;
  /** Worker-pipeline toggles (issue #106), read fresh on each decision. */
  workerSettings?: () => WorkerPipelineSettings;
  /** Routes a watcher event into the automation (the shared event router). */
  onWatcherEvent: (projectId: string, event: GithubWatcherEvent) => void;
  /** Routes a PR pipeline event onto the kanban broadcast bridge. */
  onPrEvent: (projectId: string, event: PRPipelineEvent) => void;
  onError: (err: unknown, where: string) => void;
}

/**
 * Builds one project's unit (watchers + pipelines + tracker + cursor).
 * Returns `undefined` when the project is not watchable (unparseable
 * repoUrl, or it vanished between listing and building).
 */
export function buildUnit(deps: UnitBuilderDeps, projectId: string, repoUrl: string, configKey: string): ProjectUnit | undefined {
  let repo: RepoRef;
  try {
    repo = parseRepoUrl(repoUrl);
  } catch (err) {
    deps.onError(err, `watcher:${projectId}`);
    return undefined;
  }
  const gh = deps.gh(repoUrl);
  const project = deps.projects.get(projectId);
  if (project === undefined) return undefined;
  const emit = (event: GithubWatcherEvent): void => deps.onWatcherEvent(projectId, event);

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
          pollIntervalMs: deps.pollIntervalMs,
          emit,
          onError: (err) => deps.onError(err, `issue-watcher:${projectId}`),
        });
  const prWatcher = new PullRequestWatcher({
    gh,
    projectId,
    repo,
    pollIntervalMs: deps.pollIntervalMs,
    emit,
    onError: (err) => deps.onError(err, `pr-watcher:${projectId}`),
  });
  const tracker = new PRTracker(trackerFilePath(deps.stateDir, projectId));
  const issueCursor = new IssueCursor(cursorFilePath(deps.stateDir, projectId));
  const prPipeline = new PullRequestPipeline({
    gh,
    projectId,
    repo,
    sessions: deps.sessionControl,
    tracker,
    emit: (event) => deps.onPrEvent(projectId, event),
    pollIntervalMs: deps.pollIntervalMs,
    workerSettings: deps.workerSettings,
    // Issue #107: review-agent spawns respect the project's worker cap,
    // read fresh so a settings change lands without a restart.
    workerCap: () => deps.projects.get(projectId)?.settings.workerConcurrency,
    onError: (err) => deps.onError(err, `pr-pipeline:${projectId}`),
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
