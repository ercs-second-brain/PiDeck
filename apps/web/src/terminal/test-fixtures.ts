import type { Project, Session, Worker } from "@pideck/shared";

/** Standard Project fixture shared by the terminal test files. */
export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "agentskiss",
    name: "agentsKISS",
    repoUrl: "https://github.com/ercs-second-brain/agentsKISS",
    defaultBranch: "main",
    settings: { workerConcurrency: 2 },
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Standard Session fixture (issue #394 F4): a live worker row by default. */
export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-worker-1",
    projectId: "agentskiss",
    role: "worker",
    tmuxSession: "pideck-agentskiss-worker-1",
    workerId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Standard Worker fixture (issue #394 F4): running, tied to sess-worker-1. */
export function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: "worker-1",
    projectId: "agentskiss",
    sessionId: "sess-worker-1",
    issueNumber: 7,
    prNumber: null,
    status: "running",
    statusMessage: null,
    startedAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}
