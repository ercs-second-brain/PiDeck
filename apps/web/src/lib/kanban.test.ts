import { describe, expect, it } from "vitest";
import {
  issueSchema,
  kanbanBoardSchema,
  projectSchema,
  pullRequestSchema,
  type Issue,
  type PullRequest,
} from "@agentskiss/shared";
import { deriveBoard, issueColumn, pullRequestColumn } from "./kanban";
import { advanceMockState } from "../store/store";
import { mockIssues, mockProjects, mockPullRequests, mockWorkers } from "../store/mockData";

const project = mockProjects[0]!;

describe("mock data validity", () => {
  it("all mock entities parse against the shared schemas", () => {
    for (const p of mockProjects) expect(projectSchema.parse(p)).toBeTruthy();
    for (const i of mockIssues) expect(issueSchema.parse(i)).toBeTruthy();
    for (const pr of mockPullRequests) expect(pullRequestSchema.parse(pr)).toBeTruthy();
  });
});

describe("column derivation", () => {
  const openIssue: Issue = { ...mockIssues[0]!, state: "open", assignee: null };
  const assignedIssue: Issue = { ...openIssue, assignee: "agentskiss-bot" };
  const closedIssue: Issue = { ...openIssue, state: "closed" };

  it("open + unassigned issue → backlog", () => {
    expect(issueColumn(openIssue, undefined)).toBe("backlog");
  });

  it("open + assigned issue → in_progress", () => {
    expect(issueColumn(assignedIssue, undefined)).toBe("in_progress");
  });

  it("worker-driven issue → in_progress", () => {
    const worker = mockWorkers[0]!;
    expect(issueColumn(openIssue, worker)).toBe("in_progress");
  });

  it("closed issue → done", () => {
    expect(issueColumn(closedIssue, undefined)).toBe("done");
  });

  const basePr: PullRequest = { ...mockPullRequests[0]!, state: "open", ciStatus: "running", reviewState: "none" };

  it("open PR, CI running, no review → in_progress", () => {
    expect(pullRequestColumn(basePr)).toBe("in_progress");
  });

  it("open PR with successful CI → in_review", () => {
    expect(pullRequestColumn({ ...basePr, ciStatus: "success" })).toBe("in_review");
  });

  it("open PR under review → in_review", () => {
    expect(pullRequestColumn({ ...basePr, reviewState: "pending" })).toBe("in_review");
  });

  it("merged PR → done", () => {
    expect(pullRequestColumn({ ...basePr, state: "merged" })).toBe("done");
  });

  it("closed (unmerged) PR → done", () => {
    expect(pullRequestColumn({ ...basePr, state: "closed" })).toBe("done");
  });
});

describe("deriveBoard", () => {
  it("produces all four shared KANBAN_COLUMNS in order", () => {
    const board = deriveBoard(project, mockIssues, mockPullRequests, mockWorkers);
    expect(board.projectId).toBe(project.id);
    expect(board.columns.map((c) => c.column)).toEqual(["backlog", "in_progress", "in_review", "done"]);
    expect(kanbanBoardSchema.parse(board)).toBeTruthy();
  });

  it("ignores entities belonging to other projects", () => {
    const board = deriveBoard(project, mockIssues, mockPullRequests, mockWorkers);
    for (const column of board.columns) {
      for (const card of column.cards) {
        expect(card.projectId).toBe(project.id);
        expect(card.number).not.toBe(11); // pi-themes issue
        expect(card.number).not.toBe(24); // pi-themes PR
      }
    }
  });

  it("routes cards by entity state", () => {
    const board = deriveBoard(project, mockIssues, mockPullRequests, mockWorkers);
    const inBacklog = board.columns[0]!.cards;
    const inProgress = board.columns[1]!.cards;
    const inReview = board.columns[2]!.cards;
    const done = board.columns[3]!.cards;

    // Issue 6 is open + unassigned → backlog; issue 13 likewise.
    expect(inBacklog.map((c) => `#${c.number}`)).toEqual(["#6", "#13"]);
    // Issue 7 is open + assigned with a running worker → in_progress; PR 21
    // is open with CI still running and no review yet → in_progress too.
    expect(inProgress.map((c) => `#${c.number}`)).toEqual(["#7", "#21"]);
    // PR 19 has passing CI and a pending review → in_review.
    expect(inReview.map((c) => c.number)).toEqual([19]);
    // Merged PRs and closed issue → done.
    expect(done.map((c) => c.kind).sort()).toEqual(["issue", "pull_request", "pull_request"]);
  });

  it("moves cards when state changes (issue → worker → PR → merged)", () => {
    const before = deriveBoard(project, mockIssues, mockPullRequests, mockWorkers);
    const unassigned = mockIssues.filter((i) => i.state === "open" && i.assignee === null);
    const inBacklogBefore = before.columns[0]!.cards.length;
    expect(unassigned.length).toBeGreaterThan(0);

    // Assign an issue: its card leaves backlog for in_progress.
    const assigned = mockIssues.map((i) => (i.number === unassigned[0]!.number ? { ...i, assignee: "bot" } : i));
    const after = deriveBoard(project, assigned, mockPullRequests, mockWorkers);
    expect(after.columns[0]!.cards.length).toBe(inBacklogBefore - 1);
    expect(after.columns[1]!.cards.some((c) => c.number === unassigned[0]!.number)).toBe(true);
  });
});

describe("advanceMockState (mock lifecycle demo)", () => {
  const initialState = () => ({
    projects: mockProjects,
    issues: mockIssues,
    pullRequests: mockPullRequests,
    workers: mockWorkers,
  });

  it("walks the pipeline: PR → CI → merge → reset → new worker spawned", () => {
    let state = initialState();

    // The mock starts with a running worker (w-agentskiss-7, no PR yet).
    // Step 1: it opens a PR → its card moves toward In Review.
    state = advanceMockState(state);
    const worker = state.workers.find((w) => w.id === "w-agentskiss-7")!;
    expect(worker.prNumber).not.toBeNull();
    expect(worker.status).toBe("awaiting_ci");
    const prNumber = worker.prNumber!;
    const pr = state.pullRequests.find((p) => p.number === prNumber)!;
    expect(pr.state).toBe("open");
    expect(pr.ciStatus).toBe("running");

    // Step 2: CI passes, review requested.
    state = advanceMockState(state);
    const reviewed = state.pullRequests.find((p) => p.number === prNumber)!;
    expect(reviewed.ciStatus).toBe("success");
    expect(reviewed.reviewState).toBe("pending");

    // Step 3: approved PR merges, its issue closes, worker finishes.
    state = advanceMockState(state);
    const merged = state.pullRequests.find((p) => p.number === prNumber)!;
    expect(merged.state).toBe("merged");
    expect(state.issues.find((i) => i.number === worker.issueNumber)!.state).toBe("closed");
    expect(state.workers.find((w) => w.id === "w-agentskiss-7")!.status).toBe("done");

    // Step 4: with the worker finished, the next unassigned issue gets one.
    state = advanceMockState(state);
    const spawned = state.workers.filter((w) => w.status === "running");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.id).toBe("w-agentskiss-6");
  });

  it("resets when the pipeline drains (all issues closed, no workers)", () => {
    const state = {
      projects: mockProjects,
      issues: mockIssues.map((i) => ({ ...i, state: "closed" as const })),
      pullRequests: mockPullRequests,
      workers: [],
    };
    const next = advanceMockState(state);
    const projectIssues = next.issues.filter((i) => i.projectId === project.id);
    expect(projectIssues.every((i) => i.state === "open" && i.assignee === null)).toBe(true);
    // Non-merged PRs are cleared so the demo cycle restarts cleanly.
    expect(next.pullRequests.filter((pr) => pr.projectId === project.id && pr.state === "open")).toHaveLength(0);
  });

  it("never mutates the previous state object", () => {
    const state = {
      projects: mockProjects,
      issues: mockIssues,
      pullRequests: mockPullRequests,
      workers: mockWorkers,
    };
    const snapshot = structuredClone({ issues: state.issues, pullRequests: state.pullRequests, workers: state.workers });
    advanceMockState(state);
    expect({ issues: state.issues, pullRequests: state.pullRequests, workers: state.workers }).toEqual(snapshot);
  });
});
