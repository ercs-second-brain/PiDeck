/**
 * Tests for `POST /api/projects/:projectId/assign` (issue #491): assigning
 * an issue to the daemon's gh account is the worker trigger for existing
 * issues — the route only mutates the GitHub issue (the watcher's
 * `issue.assigned` transition drives the spawn), and re-triggers by
 * unassign + re-assign when the account is already assigned.
 *
 * Hermetic: GhClient runs over the in-memory fake gh runner (testutil).
 */

import { describe, expect, it, vi } from "vitest";

import { testDaemon, UPDATED_AT, type FakeGhRoutes } from "./testutil.js";
import { assignIssue } from "./cli-handlers.js";
import type { GithubWatcherEvent } from "@pideck/shared";

/** The gh account the fake auth probe reports (`/user`). */
const GH_LOGIN = "auto-agent";

/** An issue-assignees REST response (POST returns the updated issue). */
function assigneesResponse(...logins: string[]): unknown {
  return { assignees: logins.map((login) => ({ login })) };
}

/** Routes for one registered project with a fresh and an assigned issue. */
function assignRoutes(): FakeGhRoutes {
  return {
    api: {
      "/user": { login: GH_LOGIN },
      "/repos/o/r/issues/5": {
        number: 5,
        title: "Fresh issue",
        state: "open",
        user: { login: "someone" },
        assignee: null,
        assignees: [],
        html_url: "https://github.com/o/r/issues/5",
        updated_at: UPDATED_AT,
      },
      "/repos/o/r/issues/7": {
        number: 7,
        title: "Already assigned",
        state: "open",
        user: { login: "someone" },
        assignee: { login: GH_LOGIN },
        assignees: [{ login: GH_LOGIN }],
        html_url: "https://github.com/o/r/issues/7",
        updated_at: UPDATED_AT,
      },
      // Mutations: the fake records nothing, but the route table must serve
      // both the DELETE and the POST assignee writes.
      "/repos/o/r/issues/5/assignees": assigneesResponse(GH_LOGIN),
      "/repos/o/r/issues/7/assignees": assigneesResponse(GH_LOGIN),
    },
  };
}

describe("assignIssue (issue #491)", () => {
  it("assigns an unassigned issue without an unassign round-trip", async () => {
    const { services } = testDaemon(assignRoutes());
    await services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    const result = await assignIssue(services, "o-r", 5);
    expect(result).toEqual({ ok: true, issueNumber: 5, assignee: GH_LOGIN, retriggered: false });
  });

  it("re-triggers an already-assigned issue via unassign + re-assign", async () => {
    const { services } = testDaemon(assignRoutes());
    await services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    const result = await assignIssue(services, "o-r", 7);
    expect(result).toEqual({ ok: true, issueNumber: 7, assignee: GH_LOGIN, retriggered: true });
  });

  it("synthesizes the unassign→re-assign event pair on the re-trigger path (issue #509)", async () => {
    const { services } = testDaemon(assignRoutes());
    await services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    const routed: Array<{ projectId: string; event: GithubWatcherEvent }> = [];
    vi.spyOn(services.automation, "handleWatcherEvent").mockImplementation((projectId, event) => {
      routed.push({ projectId, event });
    });
    await assignIssue(services, "o-r", 7);
    // The pair a straddling watcher poll would have produced, in order:
    // retract (assignee cleared) then the fresh assignment.
    expect(routed).toHaveLength(2);
    const [unassigned, assigned] = routed.map((r) => r.event);
    expect(routed[0]?.projectId).toBe("o-r");
    expect(unassigned).toMatchObject({ type: "issue.unassigned", issue: { number: 7, assignee: null } });
    expect(assigned).toMatchObject({ type: "issue.assigned", issue: { number: 7, assignee: GH_LOGIN } });
    expect(unassigned?.at).toEqual(assigned?.at);
  });

  it("synthesizes no events on the fresh-assignment path (the watcher drives that spawn)", async () => {
    const { services } = testDaemon(assignRoutes());
    await services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    const handleWatcherEvent = vi.spyOn(services.automation, "handleWatcherEvent");
    await assignIssue(services, "o-r", 5);
    expect(handleWatcherEvent).not.toHaveBeenCalled();
  });

  it("404s an unknown project before any gh call", async () => {
    const { services } = testDaemon(assignRoutes());
    await expect(assignIssue(services, "nope", 5)).rejects.toThrow(/unknown project/);
  });

  it("409s when gh is unauthenticated", async () => {
    // No "/user" route → the fake gh errors → the auth probe degrades to
    // unauthenticated, exactly like a daemon host without `gh auth login`.
    const routes = assignRoutes();
    delete routes.api!["/user"];
    const { services } = testDaemon(routes);
    await services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    await expect(assignIssue(services, "o-r", 5)).rejects.toThrow(/gh is not authenticated/);
  });

  it("400s when the number is a pull request, not an issue", async () => {
    const { services } = testDaemon({
      api: {
        "/user": { login: GH_LOGIN },
        "/repos/o/r/issues/9": {
          number: 9,
          title: "A PR",
          state: "open",
          user: { login: "someone" },
          assignee: null,
          assignees: [],
          html_url: "https://github.com/o/r/pull/9",
          updated_at: UPDATED_AT,
          pull_request: { html_url: "https://github.com/o/r/pull/9" },
        },
      },
    });
    await services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    await expect(assignIssue(services, "o-r", 9)).rejects.toThrow(/not an issue/);
  });

  it("502s when the issue fetch fails (unknown number)", async () => {
    const { services } = testDaemon(assignRoutes());
    await services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    await expect(assignIssue(services, "o-r", 1234)).rejects.toThrow(/cannot fetch issue #1234/);
  });

  it("502s when the assignment write fails", async () => {
    const { services } = testDaemon({
      api: {
        "/user": { login: GH_LOGIN },
        "/repos/o/r/issues/5": assignRoutes().api?.["/repos/o/r/issues/5"] as unknown,
        // assignees path intentionally unrouted → fake gh throws.
      },
    });
    await services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    await expect(assignIssue(services, "o-r", 5)).rejects.toThrow(/cannot assign/);
  });
});