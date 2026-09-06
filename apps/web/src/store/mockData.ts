/**
 * Mock data for Phase 1 — typed against the `@agentskiss/shared` domain
 * schemas so any drift from the real daemon contracts is a type error.
 * Issue #13 replaces this module's consumers with websocket-driven state.
 */

import type { Issue, Project, PullRequest, Worker } from "@agentskiss/shared";

export const mockProjects: Project[] = [
  {
    id: "agentskiss",
    name: "agentsKISS",
    repoUrl: "https://github.com/ercs-second-brain/agentsKISS",
    defaultBranch: "main",
    settings: { autoAgentUsername: "agentskiss-bot", workerConcurrency: 4 },
    createdAt: "2026-01-05T09:00:00.000Z",
    updatedAt: "2026-01-20T16:45:00.000Z",
  },
  {
    id: "pi-themes",
    name: "pi themes gallery",
    repoUrl: "https://github.com/ercs-second-brain/pi-themes",
    defaultBranch: "main",
    settings: { autoAgentUsername: null, workerConcurrency: 2 },
    createdAt: "2026-01-08T11:30:00.000Z",
    updatedAt: "2026-01-19T08:10:00.000Z",
  },
];

export const mockIssues: Issue[] = [
  {
    projectId: "agentskiss",
    number: 6,
    title: "Phase 1: Webapp shell + kanban UI",
    state: "open",
    blockedBy: [2],
    assignee: null,
    url: "https://github.com/ercs-second-brain/agentsKISS/issues/6",
    updatedAt: "2026-01-20T14:00:00.000Z",
  },
  {
    projectId: "agentskiss",
    number: 13,
    title: "Phase 2: Live data wiring + onboarding + diff review",
    state: "open",
    blockedBy: [6],
    assignee: null,
    url: "https://github.com/ercs-second-brain/agentsKISS/issues/13",
    updatedAt: "2026-01-19T10:00:00.000Z",
  },
  {
    projectId: "agentskiss",
    number: 7,
    title: "Web terminal (tmux attach in browser)",
    state: "open",
    blockedBy: [6],
    assignee: "agentskiss-bot",
    url: "https://github.com/ercs-second-brain/agentsKISS/issues/7",
    updatedAt: "2026-01-20T09:30:00.000Z",
  },
  {
    projectId: "agentskiss",
    number: 2,
    title: "Phase 0: Shared contracts",
    state: "closed",
    blockedBy: [],
    assignee: "agentskiss-bot",
    url: "https://github.com/ercs-second-brain/agentsKISS/issues/2",
    updatedAt: "2026-01-18T18:20:00.000Z",
  },
  {
    projectId: "pi-themes",
    number: 11,
    title: "Add solarized-dark theme",
    state: "open",
    blockedBy: [],
    assignee: null,
    url: "https://github.com/ercs-second-brain/pi-themes/issues/11",
    updatedAt: "2026-01-17T12:00:00.000Z",
  },
];

export const mockPullRequests: PullRequest[] = [
  {
    projectId: "agentskiss",
    number: 21,
    title: "feat(daemon): skeleton HTTP server + static file serving",
    state: "open",
    ciStatus: "running",
    reviewState: "none",
    headBranch: "ao/agentskiss-3/root",
    baseBranch: "main",
    author: "agentskiss-bot",
    url: "https://github.com/ercs-second-brain/agentsKISS/pull/21",
    updatedAt: "2026-01-20T15:10:00.000Z",
  },
  {
    projectId: "agentskiss",
    number: 19,
    title: "feat(web): kanban card hover states",
    state: "open",
    ciStatus: "success",
    reviewState: "pending",
    headBranch: "feat/kanban-hover",
    baseBranch: "main",
    author: "eric",
    url: "https://github.com/ercs-second-brain/agentsKISS/pull/19",
    updatedAt: "2026-01-20T11:05:00.000Z",
  },
  {
    projectId: "agentskiss",
    number: 18,
    title: "feat(shared): Phase 0 shared contracts",
    state: "merged",
    ciStatus: "success",
    reviewState: "approved",
    headBranch: "ao/agentskiss-5/root",
    baseBranch: "main",
    author: "agentskiss-bot",
    url: "https://github.com/ercs-second-brain/agentsKISS/pull/18",
    updatedAt: "2026-01-18T17:55:00.000Z",
  },
  {
    projectId: "agentskiss",
    number: 17,
    title: "chore: monorepo scaffolding + CI",
    state: "merged",
    ciStatus: "success",
    reviewState: "approved",
    headBranch: "chore/monorepo",
    baseBranch: "main",
    author: "eric",
    url: "https://github.com/ercs-second-brain/agentsKISS/pull/17",
    updatedAt: "2026-01-16T20:00:00.000Z",
  },
  {
    projectId: "pi-themes",
    number: 24,
    title: "fix(themes): contrast on dim foregrounds",
    state: "open",
    ciStatus: "failure",
    reviewState: "none",
    headBranch: "fix/dim-contrast",
    baseBranch: "main",
    author: "agentskiss-bot",
    url: "https://github.com/ercs-second-brain/pi-themes/pull/24",
    updatedAt: "2026-01-19T07:40:00.000Z",
  },
];

export const mockWorkers: Worker[] = [
  {
    id: "w-agentskiss-7",
    projectId: "agentskiss",
    sessionId: "s-agentskiss-7",
    issueNumber: 7,
    prNumber: null,
    status: "running",
    statusMessage: "Implementing web terminal shell",
    startedAt: "2026-01-20T09:00:00.000Z",
    updatedAt: "2026-01-20T09:30:00.000Z",
  },
];
