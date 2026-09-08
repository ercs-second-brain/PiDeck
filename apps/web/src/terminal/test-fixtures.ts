import type { Project } from "@pideck/shared";

/** Standard Project fixture shared by the terminal test files. */
export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "agentskiss",
    name: "agentsKISS",
    repoUrl: "https://github.com/ercs-second-brain/agentsKISS",
    defaultBranch: "main",
    settings: { autoAgentUsername: null, workerConcurrency: 2 },
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}
