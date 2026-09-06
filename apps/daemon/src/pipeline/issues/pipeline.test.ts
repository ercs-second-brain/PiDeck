import { describe, expect, it } from "vitest";
import {
  kanbanUpdateEventSchema,
  type GithubWatcherEvent,
  type Issue,
  type IssueBlocker,
  type Project,
} from "@agentskiss/shared";

import { Emitter } from "./emitter.js";
import { UnboundedScheduler } from "./scheduler.js";
import { IssueSpawnPipeline, issueCardId } from "./pipeline.js";
import type { BlockerResolver, RegisteredProject, WorkerSpawner } from "./ports.js";
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
    settings: { autoAgentUsername: "kiss-bot", workerConcurrency: 1, ...overrides },
    createdAt: now,
    updatedAt: now,
  };
}

function makeIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    projectId: PROJECT_ID,
    number,
    title: `Issue ${number}`,
    state: "open",
    blockedBy: [],
    assignee: null,
    url: `https://github.com/o/r/issues/${number}`,
    updatedAt: "2026-09-06T12:00:00Z",
    ...overrides,
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
    scheduler: new UnboundedScheduler((err) => errors.push(err)),
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
      id: issueCardId(PROJECT_ID, 1),
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
