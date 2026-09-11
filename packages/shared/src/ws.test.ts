/**
 * Websocket event contract tests for `ws.ts` (split from `index.test.ts`):
 * terminal client/server messages, kanban updates, and GitHub watcher
 * events. Domain schemas live in `domain.test.ts`.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  githubWatcherEventSchema,
  kanbanCardSchema,
  terminalClientMessageSchema,
  wsServerEventSchema,
  type GithubWatcherEvent,
  type WsServerEvent,
} from "./index.js";

const NOW = "2025-06-01T12:00:00.000Z";

describe("websocket: terminal + kanban", () => {
  it("parses terminal client messages including reconnect", () => {
    const attach = terminalClientMessageSchema.parse({ type: "terminal.attach", sessionId: "s1", cols: 80, rows: 24 });
    expect(attach.type).toBe("terminal.attach");

    const reconnect = terminalClientMessageSchema.parse({ type: "terminal.reconnect", sessionId: "s1", cols: 80, rows: 24 });
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

  it("rejects unknown message types", () => {
    expect(terminalClientMessageSchema.safeParse({ type: "terminal.hack", sessionId: "s1" }).success).toBe(false);
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

describe("websocket: kanban updates", () => {
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
      settings: { workerConcurrency: 1 },
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
          prNumbers: [],
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

  it("parses the board-revalidation push (issue #451) and rejects it without a project", () => {
    expect(wsServerEventSchema.parse({ type: "kanban.board.updated", at: NOW, projectId: "p" }).type).toBe(
      "kanban.board.updated",
    );
    expect(wsServerEventSchema.safeParse({ type: "kanban.board.updated", at: NOW }).success).toBe(false);
  });
});

describe("websocket: user notifications (issue #111)", () => {
  it("parses the merged-PR notification event", () => {
    const merged = wsServerEventSchema.parse({
      type: "notification.pr.merged",
      at: NOW,
      projectId: "p",
      prNumber: 42,
      title: "Add the thing",
    });
    expect(merged.type).toBe("notification.pr.merged");
    expect(wsServerEventSchema.safeParse({ type: "notification.pr.merged", at: NOW, projectId: "p", prNumber: 0, title: "x" }).success).toBe(false);
    expect(wsServerEventSchema.safeParse({ type: "notification.pr.exploded", at: NOW }).success).toBe(false);
  });

  it("parses the ready-for-merge notification event (issue #408)", () => {
    const ready = wsServerEventSchema.parse({
      type: "notification.pr.ready_for_merge",
      at: NOW,
      projectId: "p",
      prNumber: 42,
      title: "Add the thing",
    });
    expect(ready.type).toBe("notification.pr.ready_for_merge");
    expect(wsServerEventSchema.safeParse({ type: "notification.pr.ready_for_merge", at: NOW, projectId: "p", prNumber: 0, title: "x" }).success).toBe(false);
  });
});

describe("websocket: GitHub watcher events", () => {
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
});
