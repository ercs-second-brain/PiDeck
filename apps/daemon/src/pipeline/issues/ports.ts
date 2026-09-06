/**
 * Ports the issue→auto-spawn pipeline consumes, kept as interfaces so the
 * pipeline never depends on concrete github/ or sessions/ implementations
 * and tests can drive it entirely with fakes.
 *
 * Concrete adapters shipped here:
 * - {@link GhBlockerResolver} — resolves native "blocked by" relationships
 *   through a `GhClient` (github/ interface).
 * - {@link SessionManagerSpawner} — spawns workers through a
 *   `SessionManager` (sessions/ interface).
 */

import type { Issue, IssueBlocker, Project } from "@agentskiss/shared";
import type { SpawnedWorker } from "../../sessions/manager.js";
import type { RepoRef } from "../../github/gh.js";
import type { SessionManager } from "../../sessions/manager.js";

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** A registered project plus its parsed repository reference. */
export interface RegisteredProject {
  project: Project;
  repo: RepoRef;
}

/** Lookup of the projects the pipeline may auto-spawn in. */
export interface ProjectSource {
  /** The registered project for an issue's `projectId`, or `undefined`. */
  get(projectId: string): RegisteredProject | undefined;
}

// ---------------------------------------------------------------------------
// Blocked check
// ---------------------------------------------------------------------------

/**
 * Resolves the **full** native "blocked by" detail of an issue — closed and
 * cross-repo blockers included, mirroring GraphQL `Issue.blockedBy`. The
 * open-state filter (only `state: "open"` blockers actually block) is
 * applied by the pipeline, client-side, per the shared contract docs.
 */
export interface BlockerResolver {
  resolve(repo: RepoRef, issue: Issue): Promise<IssueBlocker[]>;
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

/**
 * Spawns workers for issues. The default adapter wraps
 * `SessionManager.spawnWorker`; the active-worker query additionally guards
 * against double-spawns after a daemon restart (the pipeline's in-memory
 * dedupe map is lost on restart, the registry is not).
 */
export interface WorkerSpawner {
  /** Spawns one worker for the issue in the project. */
  spawnWorker(projectId: string, issueNumber: number): Promise<SpawnedWorker>;
  /**
   * Issue numbers in the project that currently have a **non-terminal**
   * worker (`spawning`/`running`/CI/review states — not done/failed/stopped).
   */
  listActiveWorkerIssueNumbers(projectId: string): Promise<Set<number>>;
}

/** Adapter over the sessions facade (`SessionManager`). */
export class SessionManagerSpawner implements WorkerSpawner {
  /** Worker statuses that count as "actively working on an issue". */
  private static readonly ACTIVE_STATUSES = new Set(["spawning", "running", "awaiting_ci", "fixing_ci", "addressing_review"]);

  constructor(private readonly sessions: SessionManager) {}

  spawnWorker(projectId: string, issueNumber: number): Promise<SpawnedWorker> {
    return this.sessions.spawnWorker(projectId, { issueNumber });
  }

  async listActiveWorkerIssueNumbers(projectId: string): Promise<Set<number>> {
    const active = new Set<number>();
    for (const worker of this.sessions.listWorkers({ projectId })) {
      if (SessionManagerSpawner.ACTIVE_STATUSES.has(worker.status)) active.add(worker.issueNumber);
    }
    return active;
  }
}
