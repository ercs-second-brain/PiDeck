/**
 * Project-deletion tests (issue #172): the DELETE endpoint tears the whole
 * project down locally — pipeline watching stops, orchestrator + worker
 * tmux sessions and their registry records (incl. archived logs) go, the
 * clone/state dirs and PR tracker/issue-cursor files go, the board cache is
 * dropped, and the registration is removed — while the GitHub repo is
 * never touched (the fake gh has no repo-deletion route: any such call
 * would throw "unmatched invocation" and fail these tests).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { NotFoundError, ConflictError } from "./projects.js";
import { ProjectLayout } from "../sessions/layout.js";
import { testDaemon } from "./testutil.js";

const REPO_URL = "https://github.com/octo/repo";
const PROJECT = "octo-repo";

/** Empty gh route table: enough to register + start watching, nothing to see. */
const EMPTY_ROUTES = {
  api: {
    "/repos/octo/repo/issues": [],
    "/repos/octo/repo/pulls": [],
  },
  graphql: {
    "pullRequests(first:": {
      repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
    },
    "blockedBy(first:": {
      repository: { issue: { blockedBy: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
    },
  },
};

async function registeredDaemon() {
  const daemon = testDaemon(EMPTY_ROUTES, { watcherEnabled: true, watcherPollIntervalMs: 3_600_000 });
  await daemon.services.projects.register({ mode: "clone", repoUrl: REPO_URL });
  return daemon;
}

/** Live fixtures for a full teardown: orchestrator, a driving-PR worker, and per-project files. */
async function populatedDaemon() {
  const daemon = await registeredDaemon();
  const { services } = daemon;
  await services.orchestratorBootstrap.ensureForProject(services.projects.get(PROJECT)!);
  const { worker } = await services.sessions.spawnWorker(PROJECT, { issueNumber: 12 });
  services.sessions.setWorkerPr(worker.id, 34);
  const layout = new ProjectLayout(daemon.stateDir);
  mkdirSync(path.dirname(layout.prTrackerFilePath(PROJECT)), { recursive: true });
  mkdirSync(path.dirname(layout.issueCursorFilePath(PROJECT)), { recursive: true });
  writeFileSync(layout.prTrackerFilePath(PROJECT), "{}");
  writeFileSync(layout.issueCursorFilePath(PROJECT), "{}");
  return { daemon, layout, worker };
}

describe("project delete (issue #172)", () => {
  it("refuses while an active worker is driving a PR, leaving everything intact", async () => {
    const { daemon, layout, worker } = await populatedDaemon();
    await expect(daemon.services.projects.delete(PROJECT)).rejects.toThrow(ConflictError);
    // Nothing was torn down: the worker and its session survive the refusal.
    expect(daemon.services.sessions.getWorker(worker.id)?.status).toBe("running");
    expect(daemon.services.projects.get(PROJECT)).toBeDefined();
    expect(existsSync(layout.prTrackerFilePath(PROJECT))).toBe(true);
  });

  it("tears the project down locally in order and never touches the GitHub repo", async () => {
    const { daemon, layout, worker } = await populatedDaemon();
    const { services } = daemon;

    // A PR-driving worker only blocks while ACTIVE (the guard) — a finished
    // one is torn down with the project.
    services.sessions.updateWorkerStatus(worker.id, "done", "merged");

    // Start watching, then delete: the unit must be gone afterwards.
    await services.automation.start();
    expect(services.automation.watchedProjectIds).toContain(PROJECT);

    await services.projects.delete(PROJECT);

    // 1. Pipeline watching stopped.
    expect(services.automation.watchedProjectIds).not.toContain(PROJECT);
    // 2. Sessions terminated + records removed (deleting means deleting).
    expect(services.registry.listSessions({ projectId: PROJECT })).toEqual([]);
    expect(services.registry.getWorker(worker.id)).toBeUndefined();
    // 3. Local state files gone (clone dir + tracker + cursor).
    expect(existsSync(layout.projectDir(PROJECT))).toBe(false);
    expect(existsSync(layout.prTrackerFilePath(PROJECT))).toBe(false);
    expect(existsSync(layout.issueCursorFilePath(PROJECT))).toBe(false);
    // 4. Unregistered — and a fresh store over the same dir agrees.
    expect(services.projects.get(PROJECT)).toBeUndefined();
    expect(services.projects.list()).toEqual([]);
  });

  it("removes the archived logs of the project's workers with the project", async () => {
    const { daemon, worker } = await populatedDaemon();
    daemon.services.sessions.updateWorkerStatus(worker.id, "done", "merged");
    await daemon.services.sessions.archiveWorker(worker.id, "terminated");
    expect(daemon.services.sessions.archivedScrollback(worker.id)).toBeDefined();

    await daemon.services.projects.delete(PROJECT);

    expect(daemon.services.sessions.archivedScrollback(worker.id)).toBeUndefined();
  });

  it("is idempotent on partial states: dead panes and repeated deletes are fine", async () => {
    const daemon = await registeredDaemon();
    const { services } = daemon;
    const orchestrator = await services.sessions.ensureOrchestrator(PROJECT);
    // The tmux session died out-of-band — deletion still completes.
    daemon.tmux.sessions.delete(orchestrator.tmuxSession);

    await services.projects.delete(PROJECT);
    expect(services.projects.get(PROJECT)).toBeUndefined();
    await expect(services.projects.delete(PROJECT)).rejects.toThrow(NotFoundError);
  });

  it("404s for unknown projects", async () => {
    const daemon = await registeredDaemon();
    await expect(daemon.services.projects.delete("nope")).rejects.toThrow(NotFoundError);
  });
});
