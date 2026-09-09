import { describe, expect, it } from "vitest";

import type { GithubWatcherEvent, Issue } from "@pideck/shared";

import { makeIssue } from "../../testing/fixtures.js";
import type { SpawnedWorker } from "../../sessions/manager.js";
import { IssueSpawnPipeline } from "./pipeline.js";
import type { WorkerSpawner } from "./ports.js";
import { buildIssueSpawnPrompt } from "./prompts.js";

describe("buildIssueSpawnPrompt (issue #266)", () => {
  it("carries the issue context in a single pane-safe line", () => {
    const prompt = buildIssueSpawnPrompt(makeIssue(266, { title: "Worker spawns\nwithout a  prompt" }));
    expect(prompt).not.toMatch(/\n/);
    expect(prompt).toContain("#266");
    expect(prompt).toContain("Worker spawns without a prompt");
    expect(prompt).toContain("https://github.com/o/r/issues/266");
  });

  it("mentions the assignee when one is set", () => {
    const prompt = buildIssueSpawnPrompt(makeIssue(1, { assignee: "kiss-bot" }));
    expect(prompt).toContain("assigned to kiss-bot");
  });

  it("tells the worker to implement the issue and open a linked PR", () => {
    const prompt = buildIssueSpawnPrompt(makeIssue(1));
    expect(prompt).toContain("gh issue view 1");
    expect(prompt).toContain("report-pr");
    expect(prompt).toContain("#1");
  });
});

// ---------------------------------------------------------------------------
// Pipeline-level regression: auto-spawn carries the prompt (issue #266)
// ---------------------------------------------------------------------------

const PROJECT_ID = "proj";

function issueAssigned(issue: Issue): GithubWatcherEvent {
  return { type: "issue.assigned", at: "2026-09-06T12:00:00Z", issue };
}

/** Lets the scheduled (immediate) spawn task settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function makePipeline() {
  const spawns: Array<{ projectId: string; issueNumber: number; prompt?: string }> = [];
  const spawner: WorkerSpawner = {
    async spawnWorker(projectId, issueNumber, prompt): Promise<SpawnedWorker> {
      spawns.push({ projectId, issueNumber, ...(prompt !== undefined ? { prompt } : {}) });
      return {
        session: {
          id: "sess-1",
          projectId,
          role: "worker",
          tmuxSession: `pideck-${projectId}-worker-1`,
          workerId: "worker-1",
          createdAt: "2026-09-06T12:00:00Z",
        },
        worker: {
          id: "worker-1",
          projectId,
          sessionId: "sess-1",
          issueNumber,
          prNumber: null,
          status: "running",
          statusMessage: "agent running in tmux session",
          startedAt: "2026-09-06T12:00:00Z",
          updatedAt: "2026-09-06T12:00:00Z",
        },
      };
    },
    async listActiveWorkerIssueNumbers() {
      return new Set<number>();
    },
  };
  const pipeline = new IssueSpawnPipeline({
    projects: {
      get: () => ({
        project: {
          id: PROJECT_ID,
          name: "Proj",
          repoUrl: "https://github.com/o/r",
          defaultBranch: "main",
          settings: { autoAgentUsername: "kiss-bot" },
          createdAt: "2026-09-06T12:00:00Z",
          updatedAt: "2026-09-06T12:00:00Z",
        },
        repo: { owner: "o", repo: "r" },
      }),
    },
    blockers: { resolve: async () => [] },
    spawner,
  });
  return { pipeline, spawns };
}

describe("IssueSpawnPipeline prompt delivery (issue #266)", () => {
  it("issue-assigned spawn includes prompt", async () => {
    const { pipeline, spawns } = makePipeline();
    const issue = makeIssue(3, { projectId: PROJECT_ID, assignee: "kiss-bot", title: "Fix the  flaky  test" });

    pipeline.handleEvent(issueAssigned(issue));
    await flush();

    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({ projectId: PROJECT_ID, issueNumber: 3 });
    const prompt = spawns[0]?.prompt;
    expect(prompt).toBeDefined();
    expect(prompt).toContain("#3");
    expect(prompt).toContain("Fix the flaky test");
    expect(prompt).toContain(issue.url);
  });
});
