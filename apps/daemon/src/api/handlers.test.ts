/**
 * API-layer unit tests that don't need HTTP: project registration
 * (create/clone), store persistence across reloads, settings updates, and
 * the pure kanban column derivation.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Project } from "@agentskiss/shared";
import { workerSchema } from "@agentskiss/shared";

import { deriveBoard } from "./kanban.js";
import { NotFoundError, ProjectStore, slugify } from "./projects.js";
import { contractHandlers } from "./handlers.js";
import { reportWorkerPr, spawnWorker } from "./cli-handlers.js";
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
      reportWorkerPr(daemon.services, { tmuxSession: "pideck-x-worker-99", prNumber: 1 }),
    ).rejects.toThrow(NotFoundError);
  });
});

/** The terminate endpoint through the contract handler registry. */
function terminateHandler(services: ReturnType<typeof testDaemon>["services"]) {
  return contractHandlers(services).terminateWorker;
}

describe("terminateWorker (issue #64)", () => {
  /** Registers the project, spawns one worker, returns daemon + worker. */
  async function spawnedWorkerDaemon() {
    const daemon = testDaemon();
    await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/tw/rw" });
    const { session, worker } = await daemon.services.sessions.spawnWorker("tw-rw", { issueNumber: 5 });
    return { daemon, session, worker };
  }

  it("kills the tmux session, archives the worker, and keeps the registry record", async () => {
    const { daemon, session, worker } = await spawnedWorkerDaemon();
    expect(daemon.tmux.sessions.has(session.tmuxSession)).toBe(true);

    const archived = workerSchema.parse(
      await terminateHandler(daemon.services)({ params: { workerId: worker.id }, body: undefined }),
    );

    expect(archived.status).toBe("archived");
    expect(archived.statusMessage).toContain("terminated");
    expect(daemon.tmux.sessions.has(session.tmuxSession)).toBe(false); // pane (and pi) gone
    // History preserved: session + worker records stay queryable.
    expect(daemon.services.sessions.listSessions("tw-rw").map((s) => s.id)).toContain(session.id);
    expect(daemon.services.sessions.getWorker(worker.id)).toBeDefined();
  });

  it("archives an already-dead worker cleanly and is idempotent", async () => {
    const { daemon, session, worker } = await spawnedWorkerDaemon();
    daemon.tmux.sessions.clear(); // pane died before the terminate
    const terminate = terminateHandler(daemon.services);

    const first = workerSchema.parse(await terminate({ params: { workerId: worker.id }, body: undefined }));
    expect(first.status).toBe("archived");
    expect(daemon.tmux.sessions.has(session.tmuxSession)).toBe(false);

    const second = workerSchema.parse(await terminate({ params: { workerId: worker.id }, body: undefined }));
    expect(second.status).toBe("archived");
  });

  it("404s unknown workers and leaves orchestrators alone (workers only)", async () => {
    const { daemon } = await spawnedWorkerDaemon();
    const orchestrator = await daemon.services.sessions.ensureOrchestrator("tw-rw");
    const terminate = terminateHandler(daemon.services);

    await expect(terminate({ params: { workerId: "worker-ghost" }, body: undefined })).rejects.toThrow(NotFoundError);
    // The orchestrator session is untouched by terminate (workers-only scope).
    expect(daemon.services.sessions.listSessions("tw-rw").map((s) => s.id)).toContain(orchestrator.id);
  });

  it("frees the worker's concurrency slot (archived is not active)", async () => {
    const daemon = testDaemon();
    await daemon.services.projects.register({
      mode: "clone",
      repoUrl: "https://github.com/tw/rw",
      settings: { workerConcurrency: 1 },
    });
    const terminate = terminateHandler(daemon.services);
    const first = await spawnWorker(daemon.services, "tw-rw", { issueNumber: 1, name: "w1" });
    // Cap of 1: a second active spawn is rejected.
    await expect(spawnWorker(daemon.services, "tw-rw", { issueNumber: 2, name: "w2" })).rejects.toThrow(/cap/);

    await terminate({ params: { workerId: first.id }, body: undefined });
    // Archived no longer counts as active: the slot is free again.
    const second = await spawnWorker(daemon.services, "tw-rw", { issueNumber: 2, name: "w2" });
    expect(second.status).toBe("running");
  });
});

describe("ensureProjectOrchestrator (issue #53)", () => {
  it("creates the orchestrator once and reuses it on subsequent calls", async () => {
    const daemon = testDaemon();
    await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    const handlers = contractHandlers(daemon.services);

    const first = (await handlers.ensureProjectOrchestrator({ params: { projectId: "o-r" }, body: undefined })) as {
      id: string;
      role: string;
      projectId: string;
    };
    expect(first.role).toBe("orchestrator");
    expect(first.projectId).toBe("o-r");

    const second = (await handlers.ensureProjectOrchestrator({ params: { projectId: "o-r" }, body: undefined })) as {
      id: string;
    };
    expect(second.id).toBe(first.id);
  });

  it("404s unknown projects", async () => {
    const handlers = contractHandlers(testDaemon().services);
    await expect(handlers.ensureProjectOrchestrator({ params: { projectId: "ghost" }, body: undefined })).rejects.toThrow(
      NotFoundError,
    );
  });
});

/**
 * The spawn-time pi-auth readiness gate (issue #56): the initial prompt is
 * typed into the worker pane only when pi auth is ready; an unauthenticated
 * spawn keeps its prompt queued and its status truthful, and delivery
 * happens once auth completes. The pi probe is faked via the context's
 * `piRunner` (same hermetic pattern as the fake gh runner).
 */
describe("spawnWorker pi-auth readiness gate (issue #56)", () => {
  /** Flippable fake pi CLI + daemon with the gate in manual-delivery mode. */
  function gatedDaemon() {
    const pi = { ready: false };
    const daemon = testDaemon({}, {
      piRunner: async () => {
        if (!pi.ready) throw new Error("pi: not authenticated");
        return { stdout: '{"status":"ready"}', stderr: "" };
      },
      piAuthTtlMs: 0,
      promptGatePollIntervalMs: 0,
    });
    return { pi, daemon };
  }

  it("does not send the prompt into an unauthenticated pane and reports a truthful status", async () => {
    const { daemon } = gatedDaemon();
    await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    const worker = await spawnWorker(daemon.services, "o-r", { issueNumber: 3, name: "w1", prompt: "fix the flaky test" });
    // Truthful: held at `spawning`, never `running`, with the fix spelled out.
    expect(worker.status).toBe("spawning");
    expect(worker.statusMessage).toContain("waiting for pi auth");
    expect(worker.statusMessage).toContain("pideck onboard");
    expect(worker.statusMessage).toContain("initial prompt queued");
    // The prompt was not swallowed: it never reached the pane.
    const pane = await daemon.services.sessions.capturePane(worker.sessionId);
    expect(pane).not.toContain("fix the flaky test");
    expect(daemon.services.promptGate.size).toBe(1);
  });

  it("delivers the queued prompt once auth completes and flips the worker to running", async () => {
    const { pi, daemon } = gatedDaemon();
    await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    const worker = await spawnWorker(daemon.services, "o-r", { issueNumber: 3, name: "w1", prompt: "fix the flaky test" });

    pi.ready = true; // auth completes (e.g. after `pi /login` on the daemon host)
    await daemon.services.promptGate.deliverPending();

    const delivered = daemon.services.sessions.getWorker(worker.id);
    expect(delivered?.status).toBe("running");
    expect(delivered?.statusMessage).toContain("initial prompt delivered");
    const pane = await daemon.services.sessions.capturePane(worker.sessionId);
    expect(pane).toContain("fix the flaky test");
    expect(daemon.services.promptGate.size).toBe(0);
  });

  it("holds prompt-less (issue-backed) spawns too, then releases them on auth", async () => {
    const { pi, daemon } = gatedDaemon();
    await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    const worker = await spawnWorker(daemon.services, "o-r", { issueNumber: 4, name: "w2" });
    expect(worker.status).toBe("spawning");
    expect(worker.statusMessage).toContain("waiting for pi auth");

    pi.ready = true;
    await daemon.services.promptGate.deliverPending();
    const released = daemon.services.sessions.getWorker(worker.id);
    expect(released?.status).toBe("running");
    expect(released?.statusMessage).toBe("agent running in tmux session");
  });

  it("types the prompt immediately when pi auth is ready (unchanged ready path)", async () => {
    const daemon = testDaemon(); // default hermetic testDaemon: pi ready
    await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    const worker = await spawnWorker(daemon.services, "o-r", { issueNumber: 5, name: "w3", prompt: "ship it" });
    expect(worker.status).toBe("running");
    expect(worker.statusMessage).toContain("initial prompt delivered");
    const pane = await daemon.services.sessions.capturePane(worker.sessionId);
    expect(pane).toContain("ship it");
  });
});

describe("slugify", () => {
  it("produces filesystem/tmux-safe ids", () => {
    expect(slugify("owner/repo")).toBe("owner-repo");
    expect(slugify("My Project!!")).toBe("my-project");
    expect(() => slugify("///")).toThrow();
  });
});
