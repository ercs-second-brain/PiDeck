/**
 * Wiring regression tests for issue #504: assigning the gh account to two
 * issues back-to-back spawned only one worker. Root cause: the issue
 * watcher's first-sight branch emitted `issue.created` only for an issue
 * first seen WITH an assignee, so any issue created and assigned inside one
 * poll window (the orchestrator's create-then-assign flow, #491) never
 * triggered the spawn pipeline. The fix (github/watch.ts) emits the paired
 * `issue.assigned` transition on first sight.
 *
 * These tests drive a standalone {@link IssueWatcher} over the fake gh and
 * feed every poll's events through the same router the real watchers emit
 * into (the WatcherBase tick loop is exactly `for (event of pollOnce())
 * emit(event)`), so the full assign → watcher → router → spawn chain is
 * exercised. Same fake gh/git/tmux harness as wiring-routing.test.ts (whose
 * exported helpers these tests reuse); no network or live GitHub involved.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { FakeGhRoutes } from "../api/testutil.js";
import { IssueWatcher } from "../github/watch.js";
import { broadcasts, emptyRoutes, flush, NO_TICK, registeredDaemon } from "./wiring-routing.test.js";

const REPO_URL = "https://github.com/octo/repo";
const PROJECT = "octo-repo";
const AUTO_USER = "octo-bot";
const NOW = "2026-09-06T12:00:00.000Z";

/** REST issue payload (mapRestIssue shape) with explicit assignees. */
function restIssue(number: number, assignees: string[]): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    user: { login: AUTO_USER },
    assignee: assignees[0] !== undefined ? { login: assignees[0] } : null,
    assignees: assignees.map((login) => ({ login })),
    html_url: `https://github.com/octo/repo/issues/${number}`,
    updated_at: NOW,
  };
}

let active: TestDaemonShutdown | undefined;
afterEach(() => {
  active?.automation.stop();
  active = undefined;
});

type TestDaemonShutdown = Awaited<ReturnType<typeof registeredDaemon>>;

/** Registers the project without starting the automation (large poll interval). */
async function daemonWithRoutes(routes: FakeGhRoutes): Promise<TestDaemonShutdown> {
  const daemon = await registeredDaemon(routes, { watcherPollIntervalMs: NO_TICK });
  active = daemon;
  return daemon;
}

describe("GithubAutomation assignment trigger (#504)", () => {
  it("spawns a worker per issue for back-to-back assignments seen in one poll", async () => {
    const routes = emptyRoutes();
    const daemon = await daemonWithRoutes(routes);
    broadcasts(daemon);
    await daemon.services.automation.start();

    // A standalone IssueWatcher over the same fake gh; each poll's events
    // are fed through the same router the real watchers emit into.
    const watcher = new IssueWatcher({
      gh: daemon.services.gh(REPO_URL),
      projectId: PROJECT,
      repo: { owner: "octo", repo: "repo" },
      emit: () => {},
    });
    const pollAndRoute = async (): Promise<void> => {
      for (const event of await watcher.pollOnce()) {
        daemon.services.automation.handleWatcherEvent(PROJECT, event);
      }
    };

    // Poll 1 — backlog baseline: both issues exist unassigned; no spawn.
    routes.api["/repos/octo/repo/issues"] = [restIssue(505, []), restIssue(506, [])];
    await pollAndRoute();
    await flush();
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(0);

    // Poll 2 — the orchestrator assigned the gh account to both issues
    // back-to-back (seconds apart): each event must survive routing.
    routes.api["/repos/octo/repo/issues"] = [restIssue(505, [AUTO_USER]), restIssue(506, [AUTO_USER])];
    await pollAndRoute();
    await flush();
    const workers = daemon.services.registry.listWorkers({ projectId: PROJECT });
    expect(workers.map((w) => w.issueNumber).sort()).toEqual([505, 506]);
  });

  it("spawns for an issue created+assigned inside one poll window (create-then-assign)", async () => {
    const routes = emptyRoutes();
    const daemon = await daemonWithRoutes(routes);
    broadcasts(daemon);
    await daemon.services.automation.start();

    const watcher = new IssueWatcher({
      gh: daemon.services.gh(REPO_URL),
      projectId: PROJECT,
      repo: { owner: "octo", repo: "repo" },
      emit: () => {},
    });
    const pollAndRoute = async (): Promise<void> => {
      for (const event of await watcher.pollOnce()) {
        daemon.services.automation.handleWatcherEvent(PROJECT, event);
      }
    };

    // Poll 1 — issue #506 exists, unassigned.
    routes.api["/repos/octo/repo/issues"] = [restIssue(506, [])];
    await pollAndRoute();
    await flush();
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT })).toHaveLength(0);

    // Poll 2 — #507 was CREATED and assigned within the poll window (the
    // orchestrator's create-then-assign flow, seconds after #506's
    // assignment): the watcher's first sight of #507 already carries the
    // assignee. The paired first-sight assigned event (#504 fix) must
    // trigger its worker — this silently spawned nothing before the fix.
    routes.api["/repos/octo/repo/issues"] = [restIssue(507, [AUTO_USER]), restIssue(506, [AUTO_USER])];
    await pollAndRoute();
    await flush();
    const workers = daemon.services.registry.listWorkers({ projectId: PROJECT });
    expect(workers.map((w) => w.issueNumber).sort()).toEqual([506, 507]);
  });
});