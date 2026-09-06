/**
 * App state store.
 *
 * Seam design (for issue #13): every UI component reads state exclusively
 * through the {@link BoardStore} interface — `subscribe()` +
 * `getState()` — via `useSyncExternalStore`. The mock implementation below
 * mutates in-memory mock data when `simulateStateChange()` is called; #13
 * swaps in a websocket-backed implementation that pushes the same shape of
 * state, and no UI component changes.
 */

import { useSyncExternalStore } from "react";
import type { Issue, Project, PullRequest, Worker } from "@agentskiss/shared";
import { mockIssues, mockProjects, mockPullRequests, mockWorkers } from "./mockData";

export interface AppState {
  projects: Project[];
  issues: Issue[];
  pullRequests: PullRequest[];
  workers: Worker[];
}

export interface BoardStore {
  subscribe(listener: () => void): () => void;
  getState(): AppState;
  /**
   * Mock-only demo action: advances one entity through its lifecycle so
   * cards visibly move between columns. #13 removes this in favor of
   * server-pushed state updates.
   */
  simulateStateChange(): void;
}

const ACTIVE_WORKER_STATUSES = new Set(["spawning", "running", "awaiting_ci", "fixing_ci", "addressing_review"]);

function nowIso(): string {
  return new Date().toISOString();
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

function cloneState(state: AppState): Writable<AppState> {
  return {
    projects: state.projects.map((p) => ({ ...p, settings: { ...p.settings } })),
    issues: state.issues.map((i) => ({ ...i, blockedBy: [...i.blockedBy] })),
    pullRequests: state.pullRequests.map((pr) => ({ ...pr })),
    workers: state.workers.map((w) => ({ ...w })),
  };
}

/**
 * Pure lifecycle step for the mock demo, matching the agent-orchestrator
 * flow: unassigned issue → worker spawned (in_progress) → PR opened
 * (in_review) → CI green → review approved → merged + issue closed (done).
 * Cycles back to the start when the pipeline drains so the demo can repeat.
 */
export function advanceMockState(state: AppState): AppState {
  const next = cloneState(state);
  const firstProject = next.projects[0];
  if (!firstProject) return next;

  const issues = next.issues.filter((i) => i.projectId === firstProject.id);
  const workers = next.workers.filter((w) => w.projectId === firstProject.id);
  const ts = nowIso();

  const activeWorker = workers.find((w) => ACTIVE_WORKER_STATUSES.has(w.status));

  // 1. Spawn a worker for the first unassigned open issue.
  const unassigned = issues.find((i) => i.state === "open" && i.assignee === null);
  if (unassigned && !activeWorker) {
    unassigned.assignee = firstProject.settings.autoAgentUsername ?? "agentskiss-bot";
    unassigned.updatedAt = ts;
    next.workers.push({
      id: `w-${firstProject.id}-${unassigned.number}`,
      projectId: firstProject.id,
      sessionId: `s-${firstProject.id}-${unassigned.number}`,
      issueNumber: unassigned.number,
      prNumber: null,
      status: "running",
      statusMessage: "Working on the issue",
      startedAt: ts,
      updatedAt: ts,
    });
    return next;
  }

  // 2. Active worker without a PR opens one → card moves to In Review.
  if (activeWorker && activeWorker.prNumber === null) {
    const issue = next.issues.find(
      (i) => i.projectId === firstProject.id && i.number === activeWorker.issueNumber,
    );
    const prNumber = 100 + activeWorker.issueNumber;
    next.pullRequests.push({
      projectId: firstProject.id,
      number: prNumber,
      title: `fix: address #${activeWorker.issueNumber} — ${issue?.title ?? "issue work"}`,
      state: "open",
      ciStatus: "running",
      reviewState: "none",
      headBranch: `ao/worker-${activeWorker.issueNumber}/root`,
      baseBranch: firstProject.defaultBranch,
      author: "agentskiss-bot",
      url: `${firstProject.repoUrl}/pull/${prNumber}`,
      updatedAt: ts,
    });
    activeWorker.prNumber = prNumber;
    activeWorker.status = "awaiting_ci";
    activeWorker.statusMessage = "Awaiting CI on opened PR";
    activeWorker.updatedAt = ts;
    return next;
  }

  // 3. Awaiting-CI PR's checks finish → review requested.
  const awaitingCi = workers.find((w) => w.status === "awaiting_ci");
  if (awaitingCi && awaitingCi.prNumber !== null) {
    const pr = next.pullRequests.find(
      (p) => p.projectId === firstProject.id && p.number === awaitingCi.prNumber,
    );
    if (pr && pr.state === "open") {
      pr.ciStatus = "success";
      pr.reviewState = "pending";
      pr.updatedAt = ts;
      awaitingCi.status = "addressing_review";
      awaitingCi.statusMessage = "Waiting on review";
      awaitingCi.updatedAt = ts;
      return next;
    }
  }

  // 4. Approved, passing PR merges; its issue closes and the worker finishes.
  const reviewing = workers.find((w) => w.status === "addressing_review");
  if (reviewing && reviewing.prNumber !== null) {
    const pr = next.pullRequests.find(
      (p) => p.projectId === firstProject.id && p.number === reviewing.prNumber,
    );
    const issue = next.issues.find((i) => i.projectId === firstProject.id && i.number === reviewing.issueNumber);
    if (pr && pr.state === "open") {
      pr.state = "merged";
      pr.reviewState = "approved";
      pr.ciStatus = "success";
      pr.updatedAt = ts;
      if (issue) {
        issue.state = "closed";
        issue.updatedAt = ts;
      }
      reviewing.status = "done";
      reviewing.statusMessage = null;
      reviewing.updatedAt = ts;
      return next;
    }
  }

  // 5. Pipeline drained — reset the demo loop.
  next.issues = next.issues.map((i) =>
    i.projectId === firstProject.id ? { ...i, state: "open", assignee: null, updatedAt: ts } : i,
  );
  next.pullRequests = next.pullRequests.filter((pr) => pr.projectId !== firstProject.id || pr.state === "merged");
  next.workers = next.workers.filter((w) => w.projectId !== firstProject.id);
  return next;
}

function createMockStore(): BoardStore {
  let state: AppState = {
    projects: mockProjects,
    issues: mockIssues,
    pullRequests: mockPullRequests,
    workers: mockWorkers,
  };
  const listeners = new Set<() => void>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    simulateStateChange() {
      state = advanceMockState(state);
      for (const listener of listeners) listener();
    },
  };
}

/** Single app-wide store instance. Module-level so React re-renders on change. */
export const boardStore: BoardStore = createMockStore();

/** React binding — the only store API UI components are allowed to use. */
export function useAppState(): AppState {
  return useSyncExternalStore(boardStore.subscribe, boardStore.getState);
}
