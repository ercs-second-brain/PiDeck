import { describe, expect, expectTypeOf, it } from "vitest";
import {
  endpoints,
  formatPath,
  isoDateTimeSchema,
  kanbanBoardSchema,
  issueSchema,
  kanbanCardSchema,
  KANBAN_COLUMNS,
  projectSchema,
  sessionSchema,
  workerSchema,
  workerStatusSchema,
  wsServerEventSchema,
  type EndpointRequest,
  type EndpointResponse,
  type IssueBlocker,
  type KanbanColumn,
  type Project,
  type SessionRole,
  type Worker,
} from "./index.js";

const NOW = "2025-06-01T12:00:00.000Z";

describe("domain: project", () => {
  it("parses a valid project", () => {
    const project = projectSchema.parse({
      id: "pideck",
      name: "PiDeck",
      repoUrl: "https://github.com/ercs-second-brain/agentsKISS",
      defaultBranch: "main",
      settings: { autoAgentUsername: "eric", workerConcurrency: 2 },
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(project.id).toBe("pideck");
    expectTypeOf(project).toEqualTypeOf<Project>();
    expectTypeOf(project.settings.workerConcurrency).toEqualTypeOf<number | null | undefined>();
  });

  it("accepts null workerConcurrency as an explicit clear (= unbounded, issue #168)", () => {
    const project = projectSchema.parse({
      id: "p",
      name: "p",
      repoUrl: "https://github.com/example/example",
      defaultBranch: "main",
      settings: { autoAgentUsername: null, workerConcurrency: null },
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(project.settings.workerConcurrency).toBeNull();
  });

  it("leaves workerConcurrency unset (unbounded) when not provided", () => {
    const project = projectSchema.parse({
      id: "p",
      name: "p",
      repoUrl: "https://github.com/example/example",
      defaultBranch: "main",
      settings: { autoAgentUsername: null },
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(project.settings.workerConcurrency).toBeUndefined();
  });

  it("rejects a workerConcurrency cap below 1", () => {
    expect(
      projectSchema.safeParse({
        id: "p",
        name: "p",
        repoUrl: "https://github.com/example/example",
        defaultBranch: "main",
        settings: { autoAgentUsername: null, workerConcurrency: 0 },
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(false);
  });

  it("rejects a non-URL repoUrl and a non-UTC timestamp", () => {
    expect(
      projectSchema.safeParse({
        id: "p",
        name: "p",
        repoUrl: "not-a-url",
        defaultBranch: "main",
        settings: { autoAgentUsername: null, workerConcurrency: 1 },
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(false);
    expect(isoDateTimeSchema.safeParse("June 1st, 2025").success).toBe(false);
  });
});

describe("domain: kanban", () => {
  it("exposes the four agent-orchestrator columns in workflow order", () => {
    expect(KANBAN_COLUMNS).toEqual(["backlog", "in_progress", "in_review", "done"]);
    expectTypeOf<KanbanColumn>().toEqualTypeOf<"backlog" | "in_progress" | "in_review" | "done">();
  });

  it("parses a board with a card in every column", () => {
    const board = kanbanBoardSchema.parse({
      projectId: "p",
      updatedAt: NOW,
      columns: KANBAN_COLUMNS.map((column) => ({
        column,
        cards: [
          {
            id: `card-${column}`,
            projectId: "p",
            kind: "issue",
            number: 1,
            title: "Example",
            column,
            workerId: null,
            updatedAt: NOW,
          },
        ],
      })),
    });
    expect(board.columns).toHaveLength(4);
    expect(board.columns.map((c) => c.column)).toEqual(KANBAN_COLUMNS);
  });

  it("rejects a card in an unknown column", () => {
    expect(
      kanbanCardSchema.safeParse({
        id: "card",
        projectId: "p",
        kind: "issue",
        number: 1,
        title: "Example",
        column: "deployed",
        workerId: null,
        updatedAt: NOW,
      }).success,
    ).toBe(false);
  });
});

describe("domain: session and worker", () => {
  it("parses orchestrator and worker sessions", () => {
    const orchestrator = sessionSchema.parse({
      id: "s1",
      projectId: "p",
      role: "orchestrator",
      tmuxSession: "p-orchestrator",
      workerId: null,
      createdAt: NOW,
    });
    const workerSession = sessionSchema.parse({
      id: "s2",
      projectId: "p",
      role: "worker",
      tmuxSession: "p-worker-7",
      workerId: "w1",
      createdAt: NOW,
    });
    expect(orchestrator.role).toBe("orchestrator");
    expect(workerSession.workerId).toBe("w1");
    expect(sessionSchema.safeParse({ ...orchestrator, role: "chat" }).success).toBe(false);
    expectTypeOf(orchestrator.role).toEqualTypeOf<SessionRole>();
  });

  it("accepts optional cwd/command on sessions and worktreePath on workers", () => {
    const session = sessionSchema.parse({
      id: "s1",
      projectId: "p",
      role: "worker",
      tmuxSession: "p-worker-1",
      workerId: "w1",
      cwd: "/home/me/.pideck/projects/p/worktrees/issue-7",
      command: "pi",
      createdAt: NOW,
    });
    expect(session.cwd).toContain("worktrees");
    expect(session.command).toBe("pi");
    expect(sessionSchema.safeParse({ ...session, cwd: "" }).success).toBe(false);
  });

  it("covers the full worker lifecycle statuses", () => {
    const worker = workerSchema.parse({
      id: "w1",
      projectId: "p",
      sessionId: "s2",
      issueNumber: 2,
      prNumber: null,
      status: "spawning",
      statusMessage: null,
      startedAt: NOW,
      updatedAt: NOW,
    });
    const located = workerSchema.parse({ ...worker, worktreePath: "/home/me/.pideck/projects/p/worktrees/issue-2" });
    expect(located.worktreePath).toContain("worktrees");
    expect(workerSchema.safeParse({ ...worker, worktreePath: "" }).success).toBe(false);
    expect(worker.status).toBe("spawning");
    for (const status of [
      "spawning",
      "running",
      "awaiting_ci",
      "fixing_ci",
      "addressing_review",
      "done",
      "failed",
      "stopped",
      "archived",
    ] as const) {
      expect(workerStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(workerStatusSchema.safeParse("meditating").success).toBe(false);
  });

  it("accepts the archived terminal status (issue #64)", () => {
    const worker = workerSchema.parse({
      id: "w1",
      projectId: "p",
      sessionId: "s2",
      issueNumber: 2,
      prNumber: null,
      status: "archived",
      statusMessage: "terminated from the webapp",
      startedAt: NOW,
      updatedAt: NOW,
    });
    expect(worker.status).toBe("archived");
  });

  it("contracts the worker terminate endpoint (issue #64)", () => {
    const endpoint = endpoints.terminateWorker;
    expect(endpoint.method).toBe("POST");
    expect(endpoint.path).toBe("/api/workers/:workerId/terminate");
    expect(formatPath("terminateWorker", { workerId: "w1" })).toBe("/api/workers/w1/terminate");
    expectTypeOf<EndpointRequest<"terminateWorker">>().toEqualTypeOf<undefined>();
    expectTypeOf<EndpointResponse<"terminateWorker">>().toEqualTypeOf<Worker>();
  });

  it("accepts freeform workers with issueNumber 0 and rejects negatives", () => {
    const base = {
      id: "w1",
      projectId: "p",
      sessionId: "s2",
      issueNumber: 0,
      prNumber: null,
      status: "running",
      statusMessage: null,
      startedAt: NOW,
      updatedAt: NOW,
    };
    // 0 = freeform spawn (no backing GitHub issue).
    expect(workerSchema.parse(base).issueNumber).toBe(0);
    expect(wsServerEventSchema.parse({ type: "worker.spawned", at: NOW, worker: base }).type).toBe("worker.spawned");
    expect(workerSchema.safeParse({ ...base, issueNumber: -1 }).success).toBe(false);
  });
});

describe("domain: worker kind and parent linkage (issue #107)", () => {
  it("accepts reviewer-kind workers with parent linkage and defaults implementers", () => {
    const base = {
      id: "w1",
      projectId: "p",
      sessionId: "s2",
      issueNumber: 0,
      prNumber: 12,
      status: "running",
      statusMessage: null,
      startedAt: NOW,
      updatedAt: NOW,
    };
    const reviewer = workerSchema.parse({ ...base, kind: "reviewer", parentWorkerId: "w2" });
    expect(reviewer.kind).toBe("reviewer");
    expect(reviewer.parentWorkerId).toBe("w2");
    expect(workerSchema.safeParse({ ...base, kind: "manager" }).success).toBe(false);
    // Absent kind/parent (all pre-#107 records) still parse: absent = implementer.
    expect(workerSchema.parse(base).kind).toBeUndefined();
    expect(workerSchema.parse(base).parentWorkerId).toBeUndefined();
  });
});

describe("domain: issue blockers", () => {
  const baseIssue = {
    projectId: "p",
    number: 7,
    title: "Blocked issue",
    state: "open",
    blockedBy: [2],
    assignee: null,
    url: "https://github.com/example/example/issues/7",
    updatedAt: NOW,
  } as const;

  it("keeps blockedBy as open same-repo blocker numbers", () => {
    const issue = issueSchema.parse(baseIssue);
    expect(issue.blockedBy).toEqual([2]);
    expectTypeOf(issue.blockedBy).toEqualTypeOf<number[]>();
  });

  it("accepts blockers without the optional detail field", () => {
    expect(issueSchema.parse(baseIssue).blockers).toBeUndefined();
  });

  it("parses blocker detail including closed and cross-repo blockers", () => {
    const blockers: IssueBlocker[] = [
      { number: 2, state: "closed", repository: null },
      { number: 5, state: "open", repository: "example/other-repo" },
    ];
    const issue = issueSchema.parse({ ...baseIssue, blockers });
    expect(issue.blockers).toEqual(blockers);
    expect(issueSchema.safeParse({ ...baseIssue, blockers: [{ number: 2, state: "merged", repository: null }] }).success)
      .toBe(false);
    expect(issueSchema.safeParse({ ...baseIssue, blockers: [{ number: 2, state: "open" }] }).success).toBe(false);
  });
});
