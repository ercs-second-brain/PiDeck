import { describe, expect, it } from "vitest";
import {
  kanbanUpdateEventSchema,
  type GithubWatcherEvent,
  type Issue,
  type IssueBlocker,
  type Project,
} from "@agentskiss/shared";

import { Emitter } from "./emitter.js";
import { QueueingScheduler } from "./scheduler.js";
import { IssueSpawnPipeline } from "./pipeline.js";
import type { BlockerResolver, RegisteredProject, WorkerSpawner } from "./ports.js";
import { makeIssue } from "../../testing/fixtures.js";
import type { SpawnedWorker } from "../../sessions/manager.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const PROJECT_ID = "proj";
const REPO = { owner: "o", repo: "r" };

function makeProject(overrides: Partial<Project["settings"]> = {}): Project {
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

function issueCreated(issue: Issue): GithubWatcherEvent {
  return { type: "issue.created", at: "2026-09-06T12:00:00Z", issue };
}

function issueAssigned(issue: Issue): GithubWatcherEvent {
  return { type: "issue.assigned", at: "2026-09-06T12:00:00Z", issue };
}

/** Blockers the fake resolver reports per issue number. */
type BlockerScript = Map<number, IssueBlocker[]>;

function scriptedBlockerResolver(script: BlockerScript, calls: number[] = []): BlockerResolver {
  return {
    async resolve(_repo, issue) {
      calls.push(issue.number);
      const detail = script.get(issue.number);
      if (detail === undefined) throw new Error(`no blocker script for #${issue.number}`);
      return detail;
    },
  };
}

function fakeSpawner(options: { active?: number[] } = {}): {
  spawner: WorkerSpawner;
  spawns: Array<{ projectId: string; issueNumber: number }>;
} {
  const spawns: Array<{ projectId: string; issueNumber: number }> = [];
  const spawner: WorkerSpawner = {
    async spawnWorker(projectId, issueNumber) {
      spawns.push({ projectId, issueNumber });
      const n = spawns.length;
      const spawned: SpawnedWorker = {
        session: {
          id: `sess-${n}`,
          projectId,
          role: "worker",
          tmuxSession: `agentskiss-${projectId}-worker-${n}`,
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
      };
      return spawned;
    },
    async listActiveWorkerIssueNumbers() {
      return new Set(options.active ?? []);
    },
  };
  return { spawner, spawns };
}

interface Harness {
  pipeline: IssueSpawnPipeline;
  spawns: Array<{ projectId: string; issueNumber: number }>;
  kanbanEvents: unknown[];
  resolveCalls: number[];
  errors: unknown[];
}

function makeHarness(options: {
  project?: Project;
  projects?: Map<string, RegisteredProject>;
  blockerScript?: BlockerScript;
  spawner?: WorkerSpawner;
}): Harness {
  const projects =
    options.projects ??
    new Map<string, RegisteredProject>([
      [PROJECT_ID, { project: options.project ?? makeProject(), repo: REPO }],
    ]);
  const resolveCalls: number[] = [];
  const blockers = scriptedBlockerResolver(options.blockerScript ?? new Map(), resolveCalls);
  const { spawner, spawns } = options.spawner === undefined ? fakeSpawner() : { spawner: options.spawner, spawns: [] as Array<{ projectId: string; issueNumber: number }> };
  const errors: unknown[] = [];
  const pipeline = new IssueSpawnPipeline({
    projects: { get: (id) => projects.get(id) },
    blockers,
    spawner,
    // Uncapped project settings ⇒ the cap-aware scheduler bypasses queueing
    // and every spawn starts immediately (same semantics the old
    // fire-and-forget scheduler provided).
    scheduler: new QueueingScheduler({ spawner, onError: (err) => errors.push(err) }),
    now: () => new Date("2026-09-06T12:00:00Z"),
    onError: (err) => errors.push(err),
  });
  const kanbanEvents: unknown[] = [];
  pipeline.kanbanEvents.on((event) => kanbanEvents.push(event));
  return { pipeline, spawns, kanbanEvents, resolveCalls, errors };
}

/** Lets the scheduled (immediate) spawn tasks settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function spawnKeys(spawns: Array<{ projectId: string; issueNumber: number }>): string[] {
  return spawns.map((s) => `${s.projectId}#${s.issueNumber}`);
}

// ---------------------------------------------------------------------------
// Spawn / not-spawn matrix
// ---------------------------------------------------------------------------

describe("IssueSpawnPipeline", () => {
  it("spawns a worker for a fresh unblocked issue and emits the kanban card move", async () => {
    const { pipeline, spawns, kanbanEvents } = makeHarness({ blockerScript: new Map([[1, []]]) });

    pipeline.handleEvent(issueCreated(makeIssue(1)));
    await flush();

    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#1`]);
    expect(kanbanEvents).toHaveLength(1);
    const event = kanbanUpdateEventSchema.parse(kanbanEvents[0]);
    expect(event.type).toBe("kanban.card.moved");
    if (event.type !== "kanban.card.moved") return;
    expect(event.projectId).toBe(PROJECT_ID);
    expect(event.from).toBe("backlog");
    expect(event.to).toBe("in_progress");
    expect(event.card).toEqual({
      id: `issue-${PROJECT_ID}-1`,
      projectId: PROJECT_ID,
      kind: "issue",
      number: 1,
      title: "Issue 1",
      column: "in_progress",
      workerId: "worker-1",
      updatedAt: "2026-09-06T12:00:00.000Z",
    });
  });

  it("does not spawn with an OPEN same-repo blocker, but retries after redelivery once unblocked", async () => {
    const script: BlockerScript = new Map([[1, [{ number: 2, state: "open", repository: null }]]]);
    const { pipeline, spawns, kanbanEvents } = makeHarness({ blockerScript: script });

    pipeline.handleEvent(issueCreated(makeIssue(1)));
    await flush();
    expect(spawns).toHaveLength(0);
    expect(kanbanEvents).toHaveLength(0);

    // Blocker closes; a redelivered event now spawns.
    script.set(1, [{ number: 2, state: "closed", repository: null }]);
    pipeline.handleEvent(issueCreated(makeIssue(1)));
    await flush();
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#1`]);
  });

  it("spawns when the only blockers are CLOSED (closed blockers do not block)", async () => {
    const { pipeline, spawns } = makeHarness({
      blockerScript: new Map([[1, [{ number: 2, state: "closed", repository: null }]]]),
    });
    pipeline.handleEvent(issueCreated(makeIssue(1)));
    await flush();
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#1`]);
  });

  it("does not spawn with an OPEN cross-repo blocker", async () => {
    const { pipeline, spawns } = makeHarness({
      blockerScript: new Map([[1, [{ number: 9, state: "open", repository: "other/repo" }]]]),
    });
    pipeline.handleEvent(issueCreated(makeIssue(1)));
    await flush();
    expect(spawns).toHaveLength(0);
  });

  it("spawns when the issue is assigned to the configured auto-agent username", async () => {
    const { pipeline, spawns } = makeHarness({ blockerScript: new Map([[3, []]]) });
    pipeline.handleEvent(issueAssigned(makeIssue(3, { assignee: "kiss-bot" })));
    await flush();
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#3`]);
  });

  it("ignores issues assigned to other users", async () => {
    const { pipeline, spawns, kanbanEvents } = makeHarness({ blockerScript: new Map([[3, []]]) });
    pipeline.handleEvent(issueAssigned(makeIssue(3, { assignee: "someone-else" })));
    await flush();
    expect(spawns).toHaveLength(0);
    expect(kanbanEvents).toHaveLength(0);
  });

  it("ignores everything when auto-spawn is disabled (null username)", async () => {
    const { pipeline, spawns } = makeHarness({
      project: makeProject({ autoAgentUsername: null }),
      blockerScript: new Map([
        [1, []],
        [2, []],
      ]),
    });
    pipeline.handleEvent(issueCreated(makeIssue(1)));
    pipeline.handleEvent(issueAssigned(makeIssue(2, { assignee: "kiss-bot" })));
    await flush();
    expect(spawns).toHaveLength(0);
  });

  it("ignores issues in unregistered projects", async () => {
    const { pipeline, spawns } = makeHarness({ blockerScript: new Map([[1, []]]) });
    pipeline.handleEvent(issueCreated(makeIssue(1, { projectId: "ghost" })));
    await flush();
    expect(spawns).toHaveLength(0);
  });

  it("ignores PR watcher events", async () => {
    const { pipeline, spawns } = makeHarness({});
    pipeline.handleEvent({
      type: "pull_request.opened",
      at: "2026-09-06T12:00:00Z",
      pullRequest: {
        projectId: PROJECT_ID,
        number: 1,
        title: "PR 1",
        state: "open",
        ciStatus: "unknown",
        reviewState: "none",
        headBranch: "feature",
        baseBranch: "main",
        author: "kiss-bot",
        url: "https://github.com/o/r/pull/1",
        updatedAt: "2026-09-06T12:00:00Z",
      },
    });
    await flush();
    expect(spawns).toHaveLength(0);
  });

  it("never spawns twice for the same issue (redelivery idempotence)", async () => {
    const { pipeline, spawns } = makeHarness({ blockerScript: new Map([[1, []]]) });
    pipeline.handleEvent(issueCreated(makeIssue(1)));
    await flush();
    pipeline.handleEvent(issueCreated(makeIssue(1)));
    pipeline.handleEvent(issueAssigned(makeIssue(1, { assignee: "kiss-bot" })));
    await flush();
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#1`]);
  });

  it("does not spawn a second worker when an active worker already exists (restart safety)", async () => {
    const { spawner, spawns } = fakeSpawner({ active: [1] });
    const { pipeline } = makeHarness({ blockerScript: new Map([[1, []]]), spawner });
    pipeline.handleEvent(issueCreated(makeIssue(1)));
    await flush();
    expect(spawns).toHaveLength(0);
  });

  it("releases the dedupe slot on spawn failure and reports the error", async () => {
    const base = fakeSpawner();
    let fail = true;
    const spawner: WorkerSpawner = {
      spawnWorker: (projectId, issueNumber) => {
        if (fail) return Promise.reject(new Error("tmux launch failed"));
        return base.spawner.spawnWorker(projectId, issueNumber);
      },
      listActiveWorkerIssueNumbers: (projectId) => base.spawner.listActiveWorkerIssueNumbers(projectId),
    };
    const { pipeline, kanbanEvents, errors } = makeHarness({
      blockerScript: new Map([[1, []]]),
      spawner,
    });

    pipeline.handleEvent(issueCreated(makeIssue(1)));
    await flush();
    expect(base.spawns).toHaveLength(0);
    expect(kanbanEvents).toHaveLength(0);
    expect(errors).toHaveLength(1);

    fail = false;
    pipeline.handleEvent(issueCreated(makeIssue(1)));
    await flush();
    expect(spawnKeys(base.spawns)).toEqual([`${PROJECT_ID}#1`]);
  });

  it("prefers inline issue.blockers detail and applies the open-state filter without resolving", async () => {
    const resolveCalls: number[] = [];
    const { spawner, spawns } = fakeSpawner();
    const pipeline = new IssueSpawnPipeline({
      projects: { get: (id) => (id === PROJECT_ID ? { project: makeProject(), repo: REPO } : undefined) },
      blockers: scriptedBlockerResolver(new Map(), resolveCalls),
      spawner,
    });

    // Inline detail contains only a closed blocker → spawn, resolver untouched.
    pipeline.handleEvent(
      issueCreated(makeIssue(7, { blockers: [{ number: 6, state: "closed", repository: null }] })),
    );
    await flush();
    expect(resolveCalls).toEqual([]);
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#7`]);

    // Inline detail with an open (cross-repo) blocker → no spawn, resolver untouched.
    pipeline.handleEvent(
      issueCreated(makeIssue(8, { blockers: [{ number: 9, state: "open", repository: "x/y" }] })),
    );
    await flush();
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#7`]);
  });

  it("exposes kanban events through a working subscribe/unsubscribe emitter", () => {
    const emitter = new Emitter<string>();
    const seen: string[] = [];
    const off = emitter.on((value) => seen.push(value));
    emitter.emit("a");
    off();
    emitter.emit("b");
    expect(seen).toEqual(["a"]);

    // A throwing listener must not break other subscribers.
    const other: string[] = [];
    const emitter2 = new Emitter<string>();
    emitter2.on(() => {
      throw new Error("boom");
    });
    emitter2.on((value) => other.push(value));
    emitter2.emit("x");
    expect(other).toEqual(["x"]);
  });
});

// ---------------------------------------------------------------------------
// Worker concurrency cap (#14)
// ---------------------------------------------------------------------------

/** Spawns register their issue as an active (non-terminal) worker. */
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
          tmuxSession: `agentskiss-${projectId}-worker-${n}`,
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
