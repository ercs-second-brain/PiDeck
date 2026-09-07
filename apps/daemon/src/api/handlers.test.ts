/**
 * API-layer unit tests that don't need HTTP: project registration
 * (create/clone), store persistence across reloads, settings updates, and
 * the pure kanban column derivation.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Project } from "@agentskiss/shared";

import { deriveBoard } from "./kanban.js";
import { NotFoundError } from "./projects.js";
import { ProjectStore, slugify } from "./projects.js";
import { reportWorkerPr } from "./handlers.js";
import { SettingsStore } from "./settings.js";
import { testDaemon } from "./testutil.js";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "o-r",
    name: "o-r",
    repoUrl: "https://github.com/o/r",
    defaultBranch: "main",
    settings: { autoAgentUsername: null, workerConcurrency: 1 },
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe("ProjectService.register", () => {
  it("creates a new private GitHub repo and clones it (create mode)", async () => {
    const daemon = testDaemon({
      repoCreate: "https://github.com/o/newrepo",
      api: {
        "/repos/o/newrepo": {
          html_url: "https://github.com/o/newrepo",
          private: true,
          owner: { login: "o" },
          name: "newrepo",
        },
      },
    });
    const created = await daemon.services.projects.register({ mode: "create", name: "newrepo" });
    expect(created.repoUrl).toBe("https://github.com/o/newrepo");
    expect(daemon.cloned.has(path.join(daemon.stateDir, "projects", "newrepo", "clone"))).toBe(true);
  });

  it("rejects duplicate project ids with a conflict", async () => {
    const daemon = testDaemon();
    await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    await expect(daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" })).rejects.toThrow(
      /already registered/,
    );
  });

  it("persists projects to <stateDir>/projects.json", async () => {
    const daemon = testDaemon();
    await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    const file = path.join(daemon.stateDir, "projects.json");
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version: number; projects: Project[] };
    expect(raw.version).toBe(1);
    expect(raw.projects.map((p) => p.id)).toContain("o-r");

    // A fresh store over the same dir sees the same projects.
    const reloaded = new ProjectStore(daemon.stateDir);
    expect(reloaded.get("o-r")?.repoUrl).toBe("https://github.com/o/r");
  });
});

describe("SettingsStore", () => {
  it("applies partial updates and reloads from disk", () => {
    const dir = testDaemon().stateDir;
    const store = new SettingsStore(dir);
    expect(store.get()).toEqual({ autoAgentUsername: null, defaultWorkerConcurrency: 1 });
    store.update({ autoAgentUsername: "auto-agent" });
    expect(store.get()).toEqual({ autoAgentUsername: "auto-agent", defaultWorkerConcurrency: 1 });

    const reloaded = new SettingsStore(dir);
    expect(reloaded.get().autoAgentUsername).toBe("auto-agent");
  });

  it("rejects out-of-contract values", () => {
    const store = new SettingsStore(testDaemon().stateDir);
    expect(() => store.update({ defaultWorkerConcurrency: 99 })).toThrow();
  });
});

describe("deriveBoard", () => {
  it("maps issues and PRs onto columns per the shared rules", () => {
    const board = deriveBoard(
      project(),
      [
        { projectId: "o-r", number: 1, title: "Open", state: "open", blockedBy: [], assignee: null, url: "https://github.com/o/r/issues/1", updatedAt: UPDATED_AT },
        { projectId: "o-r", number: 2, title: "Assigned", state: "open", blockedBy: [], assignee: "auto-agent", url: "https://github.com/o/r/issues/2", updatedAt: UPDATED_AT },
        { projectId: "o-r", number: 3, title: "Closed", state: "closed", blockedBy: [], assignee: null, url: "https://github.com/o/r/issues/3", updatedAt: UPDATED_AT },
      ],
      [
        { projectId: "o-r", number: 10, title: "Fresh PR", state: "open", ciStatus: "unknown", reviewState: "none", headBranch: "f", baseBranch: "main", author: "a", url: "https://github.com/o/r/pull/10", updatedAt: UPDATED_AT },
        { projectId: "o-r", number: 11, title: "In review", state: "open", ciStatus: "success", reviewState: "none", headBranch: "f", baseBranch: "main", author: "a", url: "https://github.com/o/r/pull/11", updatedAt: UPDATED_AT },
        { projectId: "o-r", number: 12, title: "Merged", state: "merged", ciStatus: "success", reviewState: "approved", headBranch: "f", baseBranch: "main", author: "a", url: "https://github.com/o/r/pull/12", updatedAt: UPDATED_AT },
      ],
      [],
    );
    const cards = (column: string): number[] =>
      board.columns.find((c) => c.column === column)?.cards.map((card) => card.number) ?? [];
    expect(cards("backlog")).toEqual([1]);
    expect(cards("in_progress")).toEqual([2, 10]); // assigned issue + PR without settled CI/review
    expect(cards("in_review")).toEqual([11]);
    expect(cards("done")).toEqual([3, 12]);
    expect(board.columns).toHaveLength(4);
  });

  it("links a worker without a PR to its issue card", () => {
    const board = deriveBoard(
      project(),
      [{ projectId: "o-r", number: 5, title: "Worked", state: "open", blockedBy: [], assignee: null, url: "https://github.com/o/r/issues/5", updatedAt: UPDATED_AT }],
      [],
      [
        {
          id: "worker-1",
          projectId: "o-r",
          sessionId: "sess-1",
          issueNumber: 5,
          prNumber: null,
          status: "running",
          statusMessage: null,
          startedAt: UPDATED_AT,
          updatedAt: UPDATED_AT,
        },
      ],
    );
    const card = board.columns.find((c) => c.column === "in_progress")?.cards[0];
    expect(card?.workerId).toBe("worker-1");
    expect(card?.column).toBe("in_progress");
  });
});

describe("reportWorkerPr (explicit PR→worker report, issue #49)", () => {
  /** Spawns one issue worker in the test daemon and returns it with its session. */
  async function spawnedWorker(daemon: ReturnType<typeof testDaemon>) {
    const { session, worker } = await daemon.services.sessions.spawnWorker("o-r", { issueNumber: 7 });
    return { session, worker };
  }

  it("associates a worker session's explicit PR report", async () => {
    const daemon = testDaemon();
    const { session, worker } = await spawnedWorker(daemon);
    // Before the report the heuristic fallback may still claim the worker.
    expect(daemon.services.sessions.getWorker(worker.id)?.prNumber).toBeNull();
    const updated = await reportWorkerPr(daemon.services, { tmuxSession: session.tmuxSession, prNumber: 42 });
    expect(updated.prNumber).toBe(42);
    expect(daemon.services.sessions.getWorker(worker.id)?.prNumber).toBe(42);
  });

  it("explicit report overrides a stale heuristic association", async () => {
    const daemon = testDaemon();
    const { session, worker } = await spawnedWorker(daemon);
    // Simulate a stale heuristic value (wrong PR recorded by the wiring).
    daemon.services.sessions.setWorkerPr(worker.id, 7);
    const updated = await reportWorkerPr(daemon.services, { tmuxSession: session.tmuxSession, prNumber: 42 });
    expect(updated.prNumber).toBe(42);
  });

  it("workers without a report keep prNumber null (heuristic fallback stays in charge)", async () => {
    const daemon = testDaemon();
    const { worker } = await spawnedWorker(daemon);
    // The wiring's title/branch heuristic (wiring.test.ts) claims exactly
    // these unassociated workers; the report path must not pre-fill them.
    expect(daemon.services.sessions.getWorker(worker.id)?.prNumber).toBeNull();
  });

  it("rejects non-worker sessions and unknown tmux sessions", async () => {
    const daemon = testDaemon();
    const orchestrator = await daemon.services.sessions.ensureOrchestrator("o-r");
    await expect(
      reportWorkerPr(daemon.services, { tmuxSession: orchestrator.tmuxSession, prNumber: 1 }),
    ).rejects.toThrow(/not a worker session/);
    await expect(
      reportWorkerPr(daemon.services, { tmuxSession: "agentskiss-x-worker-99", prNumber: 1 }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("slugify", () => {
  it("produces filesystem/tmux-safe ids", () => {
    expect(slugify("owner/repo")).toBe("owner-repo");
    expect(slugify("My Project!!")).toBe("my-project");
    expect(() => slugify("///")).toThrow();
  });
});
