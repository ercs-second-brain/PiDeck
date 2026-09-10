/**
 * IssueSpawnPipeline worker-concurrency-cap tests (issue #14): unblocked
 * issues beyond the cap queue FIFO and spawn as slots free; uncapped
 * projects spawn immediately; in-flight spawns count toward the cap.
 *
 * Split from pipeline.test.ts (issue #400, KISS audit F10). This file also
 * hosts the shared pipeline fakes used by pipeline-spawn.test.ts, which
 * holds the spawn matrix itself.
 */

import { describe, expect, it } from "vitest";
import {
  type GithubWatcherEvent,
  type Issue,
  type IssueBlocker,
  type Project,
} from "@pideck/shared";

import { QueueingScheduler } from "./scheduler.js";
import { IssueSpawnPipeline } from "./pipeline.js";
import type { BlockerResolver, WorkerSpawner } from "./ports.js";
import { makeIssue } from "../../testing/fixtures.js";
import type { SpawnedWorker } from "../../sessions/manager.js";

// ---------------------------------------------------------------------------
// Fakes (shared with pipeline-spawn.test.ts)
// ---------------------------------------------------------------------------

export const PROJECT_ID = "proj";
export const REPO = { owner: "o", repo: "r" };

export function makeProject(overrides: Partial<Project["settings"]> = {}): Project {
  const now = "2026-09-06T12:00:00Z";
  return {
    id: PROJECT_ID,
    name: "Proj",
    repoUrl: "https://github.com/o/r",
    defaultBranch: "main",
    settings: { autoAgentUsername: "kiss-bot", ...overrides },
    createdAt: now,
    updatedAt: now,
  };
}

export function issueCreated(issue: Issue): GithubWatcherEvent {
  return { type: "issue.created", at: "2026-09-06T12:00:00Z", issue };
}

/** Blockers the fake resolver reports per issue number. */
export type BlockerScript = Map<number, IssueBlocker[]>;

export function scriptedBlockerResolver(script: BlockerScript, calls: number[] = []): BlockerResolver {
  return {
    async resolve(_repo, issue) {
      calls.push(issue.number);
      const detail = script.get(issue.number);
      if (detail === undefined) throw new Error(`no blocker script for #${issue.number}`);
      return detail;
    },
  };
}

/** Lets the scheduled (immediate) spawn tasks settle. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

export function spawnKeys(spawns: Array<{ projectId: string; issueNumber: number }>): string[] {
  return spawns.map((s) => `${s.projectId}#${s.issueNumber}`);
}

function registrySpawner(): {
  spawner: WorkerSpawner;
  spawns: Array<{ projectId: string; issueNumber: number }>;
  stopWorker: (projectId: string, issueNumber: number) => void;
} {
  const spawns: Array<{ projectId: string; issueNumber: number }> = [];
  const active = new Map<string, Set<number>>();
  const spawner: WorkerSpawner = {
    async spawnWorker(projectId, issueNumber) {
      spawns.push({ projectId, issueNumber });
      let set = active.get(projectId);
      if (set === undefined) {
        set = new Set<number>();
        active.set(projectId, set);
      }
      set.add(issueNumber);
      const n = spawns.length;
      return {
        session: {
          id: `sess-${n}`,
          projectId,
          role: "worker",
          tmuxSession: `pideck-${projectId}-worker-${n}`,
          workerId: `worker-${n}`,
          createdAt: "2026-09-06T12:00:00Z",
        },
        worker: {
          id: `worker-${n}`,
          projectId,
          sessionId: `sess-${n}`,
          issueNumber,
          prNumber: null,
          status: "running",
          statusMessage: "agent running in tmux session",
          startedAt: "2026-09-06T12:00:00Z",
          updatedAt: "2026-09-06T12:00:00Z",
        },
      } satisfies SpawnedWorker;
    },
    async listActiveWorkerIssueNumbers(projectId) {
      return new Set(active.get(projectId) ?? []);
    },
  };
  return {
    spawner,
    spawns,
    // A worker reaching a terminal state (done/failed/stopped) frees its slot.
    stopWorker: (projectId, issueNumber) => active.get(projectId)?.delete(issueNumber),
  };
}

function makeCappedHarness(
  project: Project,
  spawner: WorkerSpawner,
): { pipeline: IssueSpawnPipeline; errors: unknown[]; drain: () => Promise<void> } {
  const errors: unknown[] = [];
  const scheduler = new QueueingScheduler({ spawner, onError: (err) => errors.push(err), pollIntervalMs: 5 });
  const pipeline = new IssueSpawnPipeline({
    projects: { get: (id) => (id === project.id ? { project, repo: REPO } : undefined) },
    blockers: scriptedBlockerResolver(new Map(), []),
    spawner,
    scheduler,
    onError: (err) => errors.push(err),
  });
  return { pipeline, errors, drain: () => scheduler.drain(project.id) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Unblocked issue (inline detail → the scripted resolver is never called). */
function openIssue(n: number): Issue {
  return makeIssue(n, { blockers: [] });
}

describe("IssueSpawnPipeline worker concurrency cap (#14)", () => {
  it("queues unblocked issues beyond the cap and spawns them FIFO as slots free", async () => {
    const project = makeProject({ workerConcurrency: 2 });
    const { spawner, spawns, stopWorker } = registrySpawner();
    const { pipeline, drain } = makeCappedHarness(project, spawner);

    for (const n of [1, 2, 3, 4, 5]) pipeline.handleEvent(issueCreated(openIssue(n)));
    await flush();
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#1`, `${PROJECT_ID}#2`]);

    // Issue 1's worker is killed/stopped → #3 spawns next (FIFO).
    stopWorker(PROJECT_ID, 1);
    await sleep(30);
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#1`, `${PROJECT_ID}#2`, `${PROJECT_ID}#3`]);

    stopWorker(PROJECT_ID, 2);
    await drain();
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#1`, `${PROJECT_ID}#2`, `${PROJECT_ID}#3`, `${PROJECT_ID}#4`]);

    stopWorker(PROJECT_ID, 3);
    await drain();
    expect(spawnKeys(spawns)).toEqual([
      `${PROJECT_ID}#1`,
      `${PROJECT_ID}#2`,
      `${PROJECT_ID}#3`,
      `${PROJECT_ID}#4`,
      `${PROJECT_ID}#5`,
    ]);
  });

  it("spawns immediately for a project with no cap (default unbounded)", async () => {
    // No workerConcurrency in settings → every unblocked issue spawns at once.
    const project = makeProject({ workerConcurrency: undefined });
    const { spawner, spawns } = registrySpawner();
    const { pipeline } = makeCappedHarness(project, spawner);

    for (const n of [1, 2, 3, 4, 5]) pipeline.handleEvent(issueCreated(openIssue(n)));
    await flush();
    expect(spawnKeys(spawns)).toEqual([
      `${PROJECT_ID}#1`,
      `${PROJECT_ID}#2`,
      `${PROJECT_ID}#3`,
      `${PROJECT_ID}#4`,
      `${PROJECT_ID}#5`,
    ]);
  });

  it("counts a stalled (in-flight) spawn toward the cap", async () => {
    const project = makeProject({ workerConcurrency: 2 });
    const { spawner, spawns, stopWorker } = registrySpawner();
    let releaseSpawn!: () => void;
    const gate = new Promise<void>((resolve) => (releaseSpawn = resolve));
    let released = false;
    const gated: WorkerSpawner = {
      spawnWorker: (projectId, issueNumber) => {
        if (issueNumber === 1 && !released) {
          return gate.then(() => spawner.spawnWorker(projectId, issueNumber));
        }
        return spawner.spawnWorker(projectId, issueNumber);
      },
      listActiveWorkerIssueNumbers: (projectId) => spawner.listActiveWorkerIssueNumbers(projectId),
    };
    const { pipeline, drain } = makeCappedHarness(project, gated);

    for (const n of [1, 2, 3]) pipeline.handleEvent(issueCreated(openIssue(n)));
    await flush();
    // #1's spawn task is still in flight (slot held by the task, not yet by a
    // worker) and #2's worker is active → #3 must wait despite cap 2.
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#2`]);

    released = true;
    releaseSpawn();
    await flush();
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#2`, `${PROJECT_ID}#1`]);

    stopWorker(PROJECT_ID, 2);
    await drain();
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#2`, `${PROJECT_ID}#1`, `${PROJECT_ID}#3`]);
  });

  it("uses the pipeline default scheduler (cap-aware) without wiring changes", async () => {
    const project = makeProject({ workerConcurrency: 1 });
    const { spawner, spawns } = registrySpawner();
    const errors: unknown[] = [];
    // No `scheduler` option: the pipeline default (QueueingScheduler) applies the cap.
    const pipeline = new IssueSpawnPipeline({
      projects: { get: (id) => (id === project.id ? { project, repo: REPO } : undefined) },
      blockers: scriptedBlockerResolver(new Map(), []),
      spawner,
      onError: (err) => errors.push(err),
    });

    pipeline.handleEvent(issueCreated(openIssue(1)));
    pipeline.handleEvent(issueCreated(openIssue(2)));
    await flush();
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#1`]);
    expect(errors).toEqual([]);
  });
});
