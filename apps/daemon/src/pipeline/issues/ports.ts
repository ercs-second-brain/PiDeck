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
import { deliverSpawnPrompt, type PromptGate } from "../../agent/prompt-gate.js";
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
   *
   * `options.lane` (issue #471) records the spawn request's conceptual
   * lane on the worker — the idle-reuse key. Omitted = lane-less (never
   * reused; the deterministic fresh-spawn default).
   */
  spawnWorker(
    projectId: string,
    issueNumber: number,
    prompt?: string,
    options?: { lane?: string },
  ): Promise<SpawnedWorker>;
  /**
   * Re-tasks an idle (`done`) worker with a follow-on task (issue #471
   * reuse): the new issue number + prompt replace the old ones on the
   * record, the worker moves to `running`, and the follow-on prompt is
   * delivered through the same prompt-gate flow as a fresh spawn. The
   * worker's lane and PR associations ride untouched (#470 prNumbers
   * accumulate). Slot-neutral: the worker already occupies its slot.
   */
  retaskWorker(workerId: string, issueNumber: number, prompt: string): Promise<Worker>;
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

  async spawnWorker(projectId: string, issueNumber: number, prompt?: string, options?: { lane?: string }): Promise<SpawnedWorker> {
    const spawned = await this.sessions.spawnWorker(projectId, {
      issueNumber,
      // Issue #471: the spawn request's conceptual lane rides onto the
      // worker record — the idle-reuse key for same-lane follow-on tasks.
      ...(options?.lane !== undefined ? { lane: options.lane } : {}),
      // Issue #266: auto-spawned workers receive the issue context as their
      // initial prompt — recorded on the worker (issue #120) and delivered
      // into the pane below (never left to idle empty).
      ...(prompt !== undefined
        ? { prompt, statusMessage: "agent running; initial prompt queued" }
        : {}),
    });
    if (prompt !== undefined) {
      // Issue #266: the initial prompt delivery is a background step — the
      // spawn resolves once the worker is up, never gated on the delivery.
      // The delivery itself is the ONE shared spawn-path dance
      // ({@link deliverSpawnPrompt}, issues #56/#318/#378; consolidated
      // from four drifted copies in issue #426); its error sink keeps a
      // delivery failure from failing the spawn (a thrown error would
      // release the pipeline's dedupe slot and double-spawn).
      void deliverSpawnPrompt(
        this.sessions,
        this.options.promptGate,
        this.options.piReady,
        { kind: "worker", worker: spawned.worker },
        prompt,
        {
          onError:
            this.options.onError ?? ((err: unknown) => console.error("[pideck/pipeline] issue-spawn prompt delivery failed:", err)),
        },
      );
    }
    return spawned;
  }

  async retaskWorker(workerId: string, issueNumber: number, prompt: string): Promise<Worker> {
    // Issue #471: the follow-on prompt's delivery is a background step,
    // exactly like a fresh spawn's (issue #266) — the retask resolves once
    // the record is updated, never gated on the delivery. The same shared
    // dance ({@link deliverSpawnPrompt}) types the prompt and flips the
    // worker's status messages; its error sink keeps a delivery failure
    // from failing the retask (the pipeline's dedupe slot must not release).
    const worker = this.sessions.retaskWorker(workerId, issueNumber, prompt, "agent running; follow-on task assigned, prompt queued (worker reuse, issue #471)");
    void deliverSpawnPrompt(
      this.sessions,
      this.options.promptGate,
      this.options.piReady,
      { kind: "worker", worker },
      prompt,
      {
        onError:
          this.options.onError ?? ((err: unknown) => console.error("[pideck/pipeline] issue-spawn prompt delivery failed:", err)),
      },
    );
    return worker;
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
