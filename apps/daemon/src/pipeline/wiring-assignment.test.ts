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
 *
 * The re-trigger tests (issue #509) call the real assign route
 * (`assignIssue`) against the running automation: the route's synthesized
 * unassign→re-assign event pair must re-spawn the worker even when the
 * watcher never observes the transition (both writes inside one poll
 * window — the watcher diffs identical assignee sets and emits nothing).
 */

import { afterEach, describe, expect, it } from "vitest";

import type { FakeGhRoutes } from "../api/testutil.js";
import { assignIssue } from "../api/cli-handlers.js";
import { IssueWatcher } from "../github/watch.js";
import { broadcasts, emptyRoutes, flush, makeIssue, NO_TICK, registeredDaemon } from "./wiring-routing.test.js";

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

// ---------------------------------------------------------------------------
// Assign-route re-trigger delivery (issue #509)
// ---------------------------------------------------------------------------

describe("assign-route re-trigger (issue #509)", () => {
  /** Gh routes for one already-assigned issue (#506) whose assignee set
   * NEVER changes across polls — the watcher observes no transition, the
   * #509 scenario. The assignees path serves both the DELETE and the POST. */
  function retriggerRoutes(): FakeGhRoutes {
    return {
      ...emptyRoutes(),
      api: {
        ...emptyRoutes().api,
        "/user": { login: AUTO_USER },
        "/repos/octo/repo/issues": [restIssue(506, [AUTO_USER])],
        "/repos/octo/repo/issues/506": restIssue(506, [AUTO_USER]),
        "/repos/octo/repo/issues/506/assignees": {
          assignees: [{ login: AUTO_USER }],
        },
      },
    };
  }

  it("re-spawns the worker when the watcher never observes the unassign→re-assign (both writes in one poll window)", async () => {
    const routes = retriggerRoutes();
    const daemon = await daemonWithRoutes(routes);
    broadcasts(daemon);
    await daemon.services.automation.start();

    // The already-running worker from the original assignment.
    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "issue.assigned",
      at: NOW,
      issue: makeIssue(506, { assignee: AUTO_USER }),
    });
    await flush();
    const old = daemon.services.registry.listWorkers({ projectId: PROJECT })[0];
    expect(old).toMatchObject({ issueNumber: 506, status: "running" });

    // The re-trigger: DELETE + POST land inside one poll window — a watcher
    // poll afterwards sees the identical assignee set and emits nothing.
    // (The standalone watcher is baselined first so its next poll is a diff
    // against the already-assigned state, exactly like the live watcher.)
    const watcher = new IssueWatcher({
      gh: daemon.services.gh(REPO_URL),
      projectId: PROJECT,
      repo: { owner: "octo", repo: "repo" },
      emit: () => {},
    });
    await watcher.pollOnce(); // baseline: watcher has seen #506 assigned
    const result = await assignIssue(daemon.services, PROJECT, 506);
    expect(result).toEqual({ ok: true, issueNumber: 506, assignee: AUTO_USER, retriggered: true });
    await flush();

    // The route's synthesized pair retracted the old worker and spawned a
    // fresh one — this was the silent loss before the fix.
    expect(daemon.services.registry.getWorker(old?.id ?? "")?.status).toBe("archived");
    const running = daemon.services.registry.listWorkers({ projectId: PROJECT, status: "running" });
    expect(running).toHaveLength(1);
    expect(running[0]?.issueNumber).toBe(506);
    expect(running[0]?.id).not.toBe(old?.id);

    // The post-fix watcher poll: identical assignee set, no events, no churn.
    expect(await watcher.pollOnce()).toEqual([]);
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT, status: "running" })).toHaveLength(1);
  });

  it("stays exactly one worker when a watcher poll straddles the DELETE and the POST (double delivery)", async () => {
    const routes = retriggerRoutes();
    const daemon = await daemonWithRoutes(routes);
    broadcasts(daemon);
    await daemon.services.automation.start();

    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "issue.assigned",
      at: NOW,
      issue: makeIssue(506, { assignee: AUTO_USER }),
    });
    await flush();
    const old = daemon.services.registry.listWorkers({ projectId: PROJECT })[0];

    // The straddle: the watcher's poll observes the intermediate unassigned
    // state between the route's DELETE and POST, then the route synthesizes
    // its pair, then the next poll observes the re-assignment.
    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "issue.unassigned",
      at: NOW,
      issue: makeIssue(506),
    });
    const result = await assignIssue(daemon.services, PROJECT, 506);
    expect(result.retriggered).toBe(true);
    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "issue.assigned",
      at: NOW,
      issue: makeIssue(506, { assignee: AUTO_USER }),
    });
    await flush();

    expect(daemon.services.registry.getWorker(old?.id ?? "")?.status).toBe("archived");
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT, status: "running" })).toHaveLength(1);
  });
});