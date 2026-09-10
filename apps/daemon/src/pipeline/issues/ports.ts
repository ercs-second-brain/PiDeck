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

import { ACTIVE_WORKER_STATUSES, type Issue, type IssueBlocker, type Project, type Worker } from "@pideck/shared";
import type { SpawnedWorker } from "../../sessions/manager.js";
import type { PromptGate } from "../../agent/prompt-gate.js";
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
 * `SessionManager`; the active-worker query additionally guards
 * against double-spawns after a daemon restart (the pipeline's in-memory
 * dedupe map is lost on restart, the registry is not).
 */
export interface WorkerSpawner {
  /**
   * Spawns one worker for the issue in the project. `prompt` (issue #266)
   * is the issue context typed into the worker's pane as its initial
   * prompt — an auto-spawned worker must never boot empty and idle.
   * Delivery is a background step: the promise resolves once the worker is
   * up (with the prompt recorded on the worker), never gated on the
   * delivery itself.
   */
  spawnWorker(projectId: string, issueNumber: number, prompt?: string): Promise<SpawnedWorker>;
  /**
   * Issue numbers in the project that currently have a **non-terminal**
   * worker (`spawning`/`running`/CI/review states — any non-terminal status).
   */
  listActiveWorkerIssueNumbers(projectId: string): Promise<Set<number>>;
  /**
   * Archives every non-terminal worker spawned for the issue (issue #416
   * retract: unassign/close must not leave zombie workers) and returns the
   * workers it archived. Terminal workers are left untouched.
   */
  archiveWorkersForIssue(projectId: string, issueNumber: number, message: string): Promise<Worker[]>;
}

/** Options for the {@link SessionManagerSpawner} adapter. */
export interface SessionManagerSpawnerOptions {
  /** Pi auth readiness probe; absent = assume ready (tests/legacy hosts). */
  piReady?: () => Promise<boolean>;
  /** Holds the prompt until pi auth becomes ready (issue #56 parity). */
  promptGate?: Pick<PromptGate, "queue">;
  /** Error sink for prompt-delivery failures. Default: console.error. */
  onError?: (err: unknown) => void;
}

/** Adapter over the sessions facade (`SessionManager`). */
export class SessionManagerSpawner implements WorkerSpawner {
  constructor(
    private readonly sessions: SessionManager,
    private readonly options: SessionManagerSpawnerOptions = {},
  ) {}

  async spawnWorker(projectId: string, issueNumber: number, prompt?: string): Promise<SpawnedWorker> {
    const spawned = await this.sessions.spawnWorker(projectId, {
      issueNumber,
      // Issue #266: auto-spawned workers receive the issue context as their
      // initial prompt — recorded on the worker (issue #120) and delivered
      // into the pane below (never left to idle empty).
      ...(prompt !== undefined
        ? { prompt, statusMessage: "agent running; initial prompt queued" }
        : {}),
    });
    if (prompt !== undefined) void this.deliverInitialPrompt(spawned.worker, prompt);
    return spawned;
  }

  /**
   * Types the initial prompt into the fresh pane (issue #266): issue #56
   * parity — never typed into an unauthenticated agent (held on the gate
   * instead), delivery failures reported through the error sink without
   * failing the spawn (the worker is up; a thrown error would release the
   * pipeline's dedupe slot and double-spawn). Runs in the background: the
   * spawn must not wait on pane typing (tmux send settle delays) or on
   * pi-auth probes.
   */
  private async deliverInitialPrompt(worker: Worker, prompt: string): Promise<void> {
    try {
      const ready = this.options.piReady === undefined ? true : await this.options.piReady();
      if (!ready && this.options.promptGate !== undefined) {
        this.options.promptGate.queue(worker, prompt);
        return;
      }
      // Issue #318: wait for pi to accept input first — the pane was just
      // created, and typing inside pi's startup window swallows the submit
      // Enter (typed-but-never-sent). Submit confirmation re-sends bare
      // Enters only, never the text.
      await this.sessions.deliverPromptWhenReady(worker.sessionId, prompt);
      this.sessions.updateWorkerStatus(worker.id, "running", "agent running; initial prompt delivered");
    } catch (err) {
      (this.options.onError ?? ((e: unknown) => console.error("[pideck/pipeline] issue-spawn prompt delivery failed:", e)))(err);
    }
  }

  async listActiveWorkerIssueNumbers(projectId: string): Promise<Set<number>> {
    const active = new Set<number>();
    for (const worker of this.sessions.listWorkers({ projectId })) {
      if (ACTIVE_WORKER_STATUSES.has(worker.status)) active.add(worker.issueNumber);
    }
    return active;
  }

  async archiveWorkersForIssue(projectId: string, issueNumber: number, message: string): Promise<Worker[]> {
    const archived: Worker[] = [];
    for (const worker of this.sessions.listWorkers({ projectId })) {
      if (worker.issueNumber !== issueNumber || !ACTIVE_WORKER_STATUSES.has(worker.status)) continue;
      const updated = await this.sessions.archiveWorker(worker.id, message);
      if (updated !== null) archived.push(updated);
    }
    return archived;
  }
}
