import { describe, expect, expectTypeOf, it } from "vitest";
import {
  endpoints,
  formatPath,
  isoDateTimeSchema,
  kanbanBoardSchema,
  githubWatcherEventSchema,
  issueSchema,
  kanbanCardSchema,
  KANBAN_COLUMNS,
  projectSchema,
  pullRequestDiffSchema,
  registerProjectRequestSchema,
  sessionSchema,
  settingsSchema,
  terminalClientMessageSchema,
  workerSchema,
  workerStatusSchema,
  wsClientMessageSchema,
  wsServerEventSchema,
  type EndpointRequest,
  type EndpointResponse,
  type GithubWatcherEvent,
  type IssueBlocker,
  type KanbanColumn,
  type Project,
  type SessionRole,
  type WsServerEvent,
} from "./index.js";

const NOW = "2025-06-01T12:00:00.000Z";

describe("domain: project", () => {
  it("parses a valid project", () => {
    const project = projectSchema.parse({
      id: "agentskiss",
      name: "agentsKISS",
      repoUrl: "https://github.com/ercs-second-brain/agentsKISS",
      defaultBranch: "main",
      settings: { autoAgentUsername: "eric", workerConcurrency: 2 },
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(project.id).toBe("agentskiss");
    expectTypeOf(project).toEqualTypeOf<Project>();
    expectTypeOf(project.settings.workerConcurrency).toEqualTypeOf<number | undefined>();
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
      cwd: "/home/me/.agentskiss/projects/p/worktrees/issue-7",
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
    const located = workerSchema.parse({ ...worker, worktreePath: "/home/me/.agentskiss/projects/p/worktrees/issue-2" });
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
    ] as const) {
      expect(workerStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(workerStatusSchema.safeParse("meditating").success).toBe(false);
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

describe("REST endpoint map", () => {
  it("covers projects CRUD/register, kanban, sessions, diffs, and settings", () => {
    const expected: Array<[string, string, string]> = [
      ["listProjects", "GET", "/api/projects"],
      ["registerProject", "POST", "/api/projects"],
      ["getProject", "GET", "/api/projects/:projectId"],
      ["updateProject", "PATCH", "/api/projects/:projectId"],
      ["deleteProject", "DELETE", "/api/projects/:projectId"],
      ["getProjectKanban", "GET", "/api/projects/:projectId/kanban"],
      ["listProjectSessions", "GET", "/api/projects/:projectId/sessions"],
      ["listProjectWorkers", "GET", "/api/projects/:projectId/workers"],
      ["listProjectPullRequests", "GET", "/api/projects/:projectId/pulls"],
      ["getPullRequestDiff", "GET", "/api/projects/:projectId/pulls/:prNumber/diff"],
      ["getSettings", "GET", "/api/settings"],
      ["updateSettings", "PUT", "/api/settings"],
    ];
    for (const [name, method, path] of expected) {
      const endpoint = endpoints[name as keyof typeof endpoints];
      expect(endpoint.method).toBe(method);
      expect(endpoint.path).toBe(path);
    }
  });

  it("derives request and response types from the schemas", () => {
    expectTypeOf<EndpointRequest<"registerProject">>().toMatchTypeOf<{ mode: "clone" | "create" }>();
    expectTypeOf<EndpointRequest<"getProject">>().toEqualTypeOf<undefined>();
    expectTypeOf<EndpointResponse<"getProjectKanban">>().toMatchTypeOf<{ projectId: string }>();
    expectTypeOf<EndpointResponse<"listProjectSessions">>().toMatchTypeOf<Array<{ role: string }>>();
  });

  it("formats paths with params", () => {
    expect(formatPath("getPullRequestDiff", { projectId: "agentskiss", prNumber: 42 })).toBe(
      "/api/projects/agentskiss/pulls/42/diff",
    );
    expect(formatPath("getProject", { projectId: "a b/c" })).toBe("/api/projects/a%20b%2Fc");
  });

  it("parses clone and create registration bodies", () => {
    const clone = registerProjectRequestSchema.parse({
      mode: "clone",
      repoUrl: "https://github.com/example/example",
    });
    expect(clone.mode).toBe("clone");

    const created = registerProjectRequestSchema.parse({ mode: "create", name: "new-repo" });
    if (created.mode !== "create") throw new Error("expected create mode");
    expect(created.isPrivate).toBe(true);

    expect(registerProjectRequestSchema.safeParse({ mode: "fork", name: "x" }).success).toBe(false);
  });

  it("validates settings with username and concurrency", () => {
    const settings = settingsSchema.parse({ autoAgentUsername: "eric", defaultWorkerConcurrency: 3 });
    expect(settings.defaultWorkerConcurrency).toBe(3);
    expect(settingsSchema.safeParse({ autoAgentUsername: "eric", defaultWorkerConcurrency: 0 }).success).toBe(false);
  });

  it("validates PR diff payloads", () => {
    const diff = pullRequestDiffSchema.parse({
      projectId: "p",
      prNumber: 7,
      headBranch: "feature",
      baseBranch: "main",
      files: [{ filename: "src/index.ts", status: "modified", additions: 10, deletions: 2 }],
      patch: "diff --git a/src/index.ts b/src/index.ts\n...",
    });
    expect(diff.files).toHaveLength(1);
    expect(pullRequestDiffSchema.safeParse({ ...diff, files: [{ ...diff.files[0], status: "moved" }] }).success).toBe(
      false,
    );
  });
});

describe("websocket events", () => {
  it("parses terminal client messages including reconnect", () => {
    const attach = terminalClientMessageSchema.parse({ type: "terminal.attach", sessionId: "s1", cols: 80, rows: 24 });
    expect(attach.type).toBe("terminal.attach");

    const reconnect = wsClientMessageSchema.parse({ type: "terminal.reconnect", sessionId: "s1", cols: 80, rows: 24 });
    expect(reconnect.type).toBe("terminal.reconnect");

    const input = terminalClientMessageSchema.parse({ type: "terminal.data", sessionId: "s1", data: "ls\r" });
    expect(input.type).toBe("terminal.data");

    expect(
      terminalClientMessageSchema.safeParse({ type: "terminal.attach", sessionId: "s1", cols: 0, rows: 24 }).success,
    ).toBe(false);
  });

  it("parses terminal server events", () => {
    const attached = wsServerEventSchema.parse({ type: "terminal.attached", at: NOW, sessionId: "s1", resumed: true });
    expect(attached.type).toBe("terminal.attached");

    const exited = wsServerEventSchema.parse({ type: "terminal.exited", at: NOW, sessionId: "s1", exitCode: 0 });
    expect(exited.type).toBe("terminal.exited");
    expect(wsServerEventSchema.safeParse({ type: "terminal.exited", at: NOW, sessionId: "s1" }).success).toBe(false);
  });

  it("parses kanban update events (card moved, project updated, worker spawned)", () => {
    const card = kanbanCardSchema.parse({
      id: "card-1",
      projectId: "p",
      kind: "pull_request",
      number: 9,
      title: "Add feature",
      column: "in_review",
      workerId: "w1",
      updatedAt: NOW,
    });
    const moved = wsServerEventSchema.parse({
      type: "kanban.card.moved",
      at: NOW,
      projectId: "p",
      cardId: "card-1",
      from: "in_progress",
      to: "in_review",
      card,
    });
    expect(moved.type).toBe("kanban.card.moved");

    expect(
      wsServerEventSchema.safeParse({
        type: "kanban.card.moved",
        at: NOW,
        projectId: "p",
        cardId: "card-1",
        from: "in_progress",
        to: "merged",
        card: { ...card, column: "merged" },
      }).success,
    ).toBe(false);

    const project = {
      id: "p",
      name: "p",
      repoUrl: "https://github.com/example/example",
      defaultBranch: "main",
      settings: { autoAgentUsername: null, workerConcurrency: 1 },
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(wsServerEventSchema.parse({ type: "project.updated", at: NOW, project }).type).toBe("project.updated");
    expect(
      wsServerEventSchema.parse({
        type: "worker.spawned",
        at: NOW,
        worker: {
          id: "w1",
          projectId: "p",
          sessionId: "s2",
          issueNumber: 2,
          prNumber: null,
          status: "running",
          statusMessage: null,
          startedAt: NOW,
          updatedAt: NOW,
        },
      }).type,
    ).toBe("worker.spawned");
    expect(
      wsServerEventSchema.parse({ type: "worker.status.changed", at: NOW, projectId: "p", workerId: "w1", status: "done" })
        .type,
    ).toBe("worker.status.changed");
  });

  it("parses GitHub watcher events (issue created/assigned, PR opened/updated)", () => {
    const issue = {
      projectId: "p",
      number: 7,
      title: "Do a thing",
      state: "open",
      blockedBy: [],
      assignee: "eric",
      url: "https://github.com/example/example/issues/7",
      updatedAt: NOW,
    };
    expect(githubWatcherEventSchema.parse({ type: "issue.created", at: NOW, issue }).type).toBe("issue.created");
    expect(githubWatcherEventSchema.parse({ type: "issue.assigned", at: NOW, issue }).type).toBe("issue.assigned");

    const pullRequest = {
      projectId: "p",
      number: 9,
      title: "Do the thing",
      state: "open",
      ciStatus: "pending",
      reviewState: "none",
      headBranch: "feature",
      baseBranch: "main",
      author: "eric",
      url: "https://github.com/example/example/pull/9",
      updatedAt: NOW,
    };
    expect(githubWatcherEventSchema.parse({ type: "pull_request.opened", at: NOW, pullRequest }).type).toBe(
      "pull_request.opened",
    );
    expect(githubWatcherEventSchema.parse({ type: "pull_request.updated", at: NOW, pullRequest }).type).toBe(
      "pull_request.updated",
    );

    expect(githubWatcherEventSchema.safeParse({ type: "issue.exploded", at: NOW, issue }).success).toBe(false);
    expect(githubWatcherEventSchema.safeParse({ type: "issue.created", at: "not-a-date", issue }).success).toBe(false);
  });

  it("narrows the watcher event union", () => {
    const event: GithubWatcherEvent = {
      type: "pull_request.updated",
      at: NOW,
      pullRequest: {
        projectId: "p",
        number: 9,
        title: "Do the thing",
        state: "open",
        ciStatus: "running",
        reviewState: "pending",
        headBranch: "feature",
        baseBranch: "main",
        author: "eric",
        url: "https://github.com/example/example/pull/9",
        updatedAt: NOW,
      },
    };
    if (event.type === "pull_request.updated") {
      expectTypeOf(event.pullRequest.ciStatus).toEqualTypeOf<"pending" | "running" | "success" | "failure" | "unknown">();
    } else {
      expect.unreachable();
    }
  });

  it("rejects unknown message types", () => {
    expect(wsClientMessageSchema.safeParse({ type: "terminal.hack", sessionId: "s1" }).success).toBe(false);
    expect(wsServerEventSchema.safeParse({ type: "kanban.exploded", at: NOW }).success).toBe(false);
  });

  it("narrows the server event union", () => {
    const event: WsServerEvent = { type: "terminal.data", at: NOW, sessionId: "s1", data: "hi" };
    if (event.type === "terminal.data") {
      expectTypeOf(event.sessionId).toEqualTypeOf<string>();
    } else {
      expect.unreachable();
    }
    expectTypeOf<WsServerEvent["type"]>().toMatchTypeOf<string>();
  });
});
