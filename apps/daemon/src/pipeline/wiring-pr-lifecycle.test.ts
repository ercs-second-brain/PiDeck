/**
 * Wiring tests for the deterministic PR lifecycle's orchestrator leg (issue
 * #408, flow step 8): when the PR loop observes a merge, the automation
 * re-evaluates the project's recorded blocked tickets and spawns workers for
 * the ones the merge unblocked — through the same spawn matrix as the
 * watcher path (dedupe + concurrency caps), so no conflict with running
 * workers is possible. Same fake gh/git/tmux harness as the other wiring
 * tests; no network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PullRequest } from "@pideck/shared";

import { testDaemon, type FakeGhRoutes, type TestDaemon } from "../api/testutil.js";
import { broadcasts, emptyRoutes, flush, registeredDaemon } from "./wiring-routing.test.js";
import { makePullRequest as sharedMakePullRequest, restPull as sharedRestPull } from "../testing/fixtures.js";

const PROJECT = "octo-repo";
const NOW = "2026-09-06T12:00:00.000Z";

let active: TestDaemon | undefined;
afterEach(() => {
  active?.services.automation.stop();
  active = undefined;
});


function blockerPage(state: "OPEN" | "CLOSED"): Record<string, unknown> {
  return {
    repository: {
      issue: { blockedBy: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ number: 2, state, repository: { nameWithOwner: "octo/repo" } }] } },
    },
  };
}

describe("GithubAutomation merge → unblock sweep (issue #408)", () => {
  it("a merged PR spawns workers for the blocked tickets its Closes-references unblocked", async () => {
    const routes: FakeGhRoutes & { api: Record<string, unknown>; graphql: Record<string, unknown> } = {
      ...emptyRoutes(),
      graphql: {
        ...emptyRoutes().graphql,
        // The spawn matrix's blockedBy resolution: issue #50 is blocked by #2.
        "blockedBy(first:": blockerPage("OPEN"),
      },
    };
    const daemon = await registeredDaemon(routes);
    active = daemon;
    const events = broadcasts(daemon);
    await daemon.services.automation.start();

    // Issue #50 arrives blocked → suppressed and recorded for the sweep.
    daemon.services.automation.handleWatcherEvent(PROJECT, {
      type: "issue.assigned",
      at: NOW,
      issue: {
        projectId: PROJECT,
        number: 50,
        title: "Follow-up work",
        state: "open",
        blockedBy: [],
        assignee: "octo-bot",
        url: "https://github.com/octo/repo/issues/50",
        updatedAt: NOW,
      },
    });
    await daemon.automation.pollCatchUp(PROJECT);
    expect(daemon.services.registry.listWorkers({ projectId: PROJECT }).filter((w) => w.issueNumber === 50)).toHaveLength(0);

    // A worker opens PR #7 and reports it.
    const { worker } = await daemon.services.sessions.spawnWorker(PROJECT, { issueNumber: 46 });
    daemon.services.registry.setWorkerPr(worker.id, 7);

    // PR #7 merges — GitHub closed its "Closes #2" issue at merge time, so
    // the sweep now resolves #50 as unblocked.
    routes.graphql["blockedBy(first:"] = blockerPage("CLOSED");
    routes.api["/repos/octo/repo/pulls"] = [mergedPull()];
    routes.api["/repos/octo/repo/pulls/7"] = mergedPull();
    routes.api["/repos/octo/repo/commits/sha-1/check-runs"] = {
      total_count: 1,
      check_runs: [{ name: "build", status: "completed", conclusion: "success" }],
    };
    routes.api["/repos/octo/repo/pulls/7/reviews"] = [];
    routes.api["/repos/octo/repo/pulls/7/comments"] = [];

    await daemon.automation.pollPrPipeline(PROJECT);
    await flush();

    expect(events.some((e) => e.type === "notification.pr.merged" && e.prNumber === 7)).toBe(true);
    expect(events.some((e) => e.type === "notification.pr.merged" && e.prNumber === 7)).toBe(true);
    const unblocked = daemon.services.registry.listWorkers({ projectId: PROJECT }).filter((w) => w.issueNumber === 50);
    expect(unblocked).toHaveLength(1);
  });
});

/** A merged PR #7 payload (the PR loop observes the merge via `merged_at`). */
function mergedPull(): Record<string, unknown> {
  // GitHub REST shape for a merged PR: state "closed" + merged_at set.
  return sharedRestPull(7, { sha: "sha-1", author: "octo-bot", headBranch: "issue-46-fix", updatedAt: NOW, closed: true, merged: true });
}

void testDaemon;

// ---------------------------------------------------------------------------
// Approval → deterministic orchestrator notification (issue #490)
// ---------------------------------------------------------------------------

/** A review submission payload for the PR's reviews route. */
function review(state: "APPROVED" | "CHANGES_REQUESTED"): Record<string, unknown> {
  return { user: { login: "review-bot" }, state, submitted_at: NOW };
}

/** The watcher-event pull request for worker PR #7 (title references issue #46). */
function makePullRequestEvent(number: number): PullRequest {
  return sharedMakePullRequest(number, {
    projectId: PROJECT,
    author: "octo-bot",
    title: "Resolve #46: fix the loop",
    headBranch: "issue-46-fix",
    url: `https://github.com/octo/repo/pull/${number}`,
    updatedAt: NOW,
  });
}

/** Routes for worker PR #7: CI green, the given reviews, no comments. */
function greenPullRoutes(reviews: Record<string, unknown>[]): Record<string, unknown> {
  const pull = sharedRestPull(7, { sha: "sha-1", author: "octo-bot", headBranch: "issue-46-fix", title: "Resolve #46: fix the loop", updatedAt: NOW });
  return {
    "/repos/octo/repo/pulls": [pull],
    "/repos/octo/repo/pulls/7": pull,
    "/repos/octo/repo/commits/sha-1/check-runs": {
      total_count: 1,
      check_runs: [{ name: "build", status: "completed", conclusion: "success" }],
    },
    "/repos/octo/repo/pulls/7/reviews": reviews,
    "/repos/octo/repo/pulls/7/comments": [],
  };
}

describe("GithubAutomation approval → orchestrator notification (issue #490)", () => {
  it("an approval on a worker's PR messages the project orchestrator's pane, once per round", async () => {
    const daemon = await registeredDaemon({ ...emptyRoutes(), api: { ...emptyRoutes().api, ...greenPullRoutes([review("APPROVED")]) } });
    active = daemon;
    const events = broadcasts(daemon);
    await daemon.services.automation.start();
    // Production start order: the orchestrator bootstrap ran before automation.start().
    const orchestrator = await daemon.services.sessions.ensureOrchestrator(PROJECT);
    // Issue #500: the fake models that bootstrapped pane — pi running, the
    // state the notification guard probes for before typing.
    daemon.tmux.sessions.get(orchestrator.tmuxSession)!.command = ["pi"];

    await daemon.services.sessions.spawnWorker(PROJECT, { issueNumber: 46 });
    daemon.services.automation.handleWatcherEvent(PROJECT, { type: "pull_request.opened", at: NOW, pullRequest: makePullRequestEvent(7) });
    await daemon.automation.pollPrPipeline(PROJECT);
    await flush();

    // The hub leg (webapp toast/notification center) is unchanged.
    expect(events.some((e) => e.type === "notification.pr.ready_for_merge" && e.prNumber === 7)).toBe(true);
    // The orchestrator leg (issue #490): the notification lands in the pane.
    const pane = daemon.tmux.sessions.get(orchestrator.tmuxSession);
    const messages = (pane?.paneLines ?? []).filter((l) => l.includes("PR #7"));
    expect(messages).toEqual(['[pideck] PR #7 "Resolve #46: fix the loop" is CI-green and approved — ready for review and merge.']);

    // Deterministic once-per-round: another poll does not re-message the pane
    // (the pipeline's readyNotifiedHeadSha watermark gates the event, so the
    // wiring's pane delivery runs exactly once per approved round too).
    await daemon.automation.pollPrPipeline(PROJECT);
    await flush();
    expect((daemon.tmux.sessions.get(orchestrator.tmuxSession)?.paneLines ?? []).filter((l) => l.includes("PR #7"))).toEqual(messages);
  });

  it("no approval → no ready-for-merge notification anywhere (hub or orchestrator pane)", async () => {
    const daemon = await registeredDaemon({ ...emptyRoutes(), api: { ...emptyRoutes().api, ...greenPullRoutes([]) } });
    active = daemon;
    const events = broadcasts(daemon);
    await daemon.services.automation.start();
    const orchestrator = await daemon.services.sessions.ensureOrchestrator(PROJECT);

    await daemon.services.sessions.spawnWorker(PROJECT, { issueNumber: 46 });
    daemon.services.automation.handleWatcherEvent(PROJECT, { type: "pull_request.opened", at: NOW, pullRequest: makePullRequestEvent(7) });
    await daemon.automation.pollPrPipeline(PROJECT);
    await flush();

    expect(events.some((e) => e.type === "notification.pr.ready_for_merge")).toBe(false);
    expect((daemon.tmux.sessions.get(orchestrator.tmuxSession)?.paneLines ?? []).some((l) => l.includes("PR #7"))).toBe(false);
  });

  it("a bare-shell orchestrator pane (pi never bootstrapped) is re-bootstrapped and the notification skipped loudly — never typed into the shell (issue #500)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // Zero input-ready budget: the fake pane never renders pi's input box,
    // so recovery cannot produce a deliverable pane — the skip path (single
    // probe, no poll sleep).
    const daemon = await registeredDaemon(
      { ...emptyRoutes(), api: { ...emptyRoutes().api, ...greenPullRoutes([review("APPROVED")]) } },
      { orchestratorRecoveryInputReadyTimeoutMs: 0 },
    );
    active = daemon;
    const events = broadcasts(daemon);
    await daemon.services.automation.start();
    // No bootstrapped-pane seed: the orchestrator pane is the bare shell
    // `ensureOrchestrator` opens when pi never bootstrapped in it.
    const orchestrator = await daemon.services.sessions.ensureOrchestrator(PROJECT);

    await daemon.services.sessions.spawnWorker(PROJECT, { issueNumber: 46 });
    daemon.services.automation.handleWatcherEvent(PROJECT, { type: "pull_request.opened", at: NOW, pullRequest: makePullRequestEvent(7) });
    await daemon.automation.pollPrPipeline(PROJECT);
    await flush();

    // The hub leg still fired (unchanged).
    expect(events.some((e) => e.type === "notification.pr.ready_for_merge" && e.prNumber === 7)).toBe(true);

    // Recovery was attempted: the orchestrator persona launch line was typed
    // into the bare shell.
    const paneLines = daemon.tmux.sessions.get(orchestrator.tmuxSession)?.paneLines ?? [];
    expect(paneLines.some((l) => l.includes("pi --no-skills --append-system-prompt"))).toBe(true);
    // The notification text itself was never typed into the shell.
    expect(paneLines.filter((l) => l.includes("PR #7"))).toEqual([]);
    // Loud skip: the actionable error is logged through the wiring's onError
    // (the recovery send's Enter settles on a real timer, so poll for it).
    await vi.waitFor(() => expect(consoleError.mock.calls.length).toBeGreaterThan(0));
    const logged = consoleError.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(logged).toContain("not bootstrapped");
    expect(logged).toContain("orchestrator-notify");
    consoleError.mockRestore();
  });

});

/** Green routes with the review-user assignee already on the PR (issue #408's spawn gate reads it from the poll payload). */
function assignedGreenPullRoutes(reviews: Record<string, unknown>[]): Record<string, unknown> {
  const pull = { ...sharedRestPull(7, { sha: "sha-1", author: "octo-bot", headBranch: "issue-46-fix", title: "Resolve #46: fix the loop", updatedAt: NOW }), assignees: [{ login: "review-bot" }] };
  return {
    ...emptyRoutes().api,
    "/repos/octo/repo/pulls": [pull],
    "/repos/octo/repo/pulls/7": pull,
    "/repos/octo/repo/commits/sha-1/check-runs": {
      total_count: 1,
      check_runs: [{ name: "build", status: "completed", conclusion: "success" }],
    },
    "/repos/octo/repo/pulls/7/reviews": reviews,
    "/repos/octo/repo/pulls/7/comments": [],
    // The assignment leg's POST (fire-and-forget at track time; the payload
    // already carries the assignee, so the spawn gate reads it).
    "/repos/octo/repo/issues/7/assignees": { assignees: [{ login: "review-bot" }] },
  };
}

describe("GithubAutomation reviewer-agent approval → orchestrator notification (issue #503)", () => {
  it("the reviewer agent's approval notifies the orchestrator pane on the poll that records it", async () => {
    // Full production reviewer flow (issue #407/#408): the review account is
    // configured, the green PR carries the review-user assignee (the spawn
    // gate), a reviewer agent spawns, and its approval — recorded on the
    // review-submission watermark — drives the notification directly.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const routes: FakeGhRoutes & { api: Record<string, unknown>; graphql: Record<string, unknown> } = {
      ...emptyRoutes(),
      api: assignedGreenPullRoutes([]),
    };
    const daemon = await registeredDaemon(routes);
    active = daemon;
    daemon.services.settings.update({ reviewAccountToken: "tok", reviewAccountUsername: "review-bot" });
    const events = broadcasts(daemon);
    await daemon.services.automation.start();
    const orchestrator = await daemon.services.sessions.ensureOrchestrator(PROJECT);
    daemon.tmux.sessions.get(orchestrator.tmuxSession)!.command = ["pi"];

    await daemon.services.sessions.spawnWorker(PROJECT, { issueNumber: 46 });
    daemon.services.automation.handleWatcherEvent(PROJECT, { type: "pull_request.opened", at: NOW, pullRequest: makePullRequestEvent(7) });
    await daemon.automation.pollPrPipeline(PROJECT);
    await flush();

    // The review cycle ran: a reviewer agent is attached to the PR.
    const reviewers = daemon.services.registry.listWorkers({ projectId: PROJECT }).filter((w) => w.kind === "reviewer");
    expect(reviewers).toHaveLength(1);
    expect(consoleError.mock.calls.map((c) => c.join(" ")).some((l) => l.includes("review-spawn"))).toBe(false);

    // The reviewer approves — the next poll records the approval and the
    // notification lands in the orchestrator pane on that same poll.
    routes.api!["/repos/octo/repo/pulls/7/reviews"] = [{ user: { login: "review-bot" }, state: "APPROVED", submitted_at: NOW }];
    await daemon.automation.pollPrPipeline(PROJECT);
    await flush();

    expect(events.filter((e) => e.type === "notification.pr.ready_for_merge")).toHaveLength(1);
    const pane = daemon.tmux.sessions.get(orchestrator.tmuxSession);
    expect((pane?.paneLines ?? []).filter((l) => l.includes("PR #7"))).toEqual([
      '[pideck] PR #7 "Resolve #46: fix the loop" is CI-green and approved — ready for review and merge.',
    ]);
    // Exactly once per approval round: the following poll stays silent.
    await daemon.automation.pollPrPipeline(PROJECT);
    await flush();
    expect((daemon.tmux.sessions.get(orchestrator.tmuxSession)?.paneLines ?? []).filter((l) => l.includes("PR #7"))).toHaveLength(1);
    consoleError.mockRestore();
  });
});
