/**
 * Unit tests for the kanban board cache (issue #88): `getProjectKanban` used
 * to hit GitHub GraphQL on every call, so the webapp's poll cadence (and any
 * request storm) became an upstream storm. The board is TTL-cached with
 * stale-while-revalidate + single-flight background refresh, mirroring
 * `PullListingService`.
 */

import { describe, expect, it } from "vitest";
import { projectSchema, type KanbanBoard, type PullRequest } from "@pideck/shared";

import { GhClient, type GhRunner } from "../github/gh.js";
import { KanbanService, deriveBoard } from "./kanban.js";

const PROJECT = "o-r";
const REPO_URL = "https://github.com/o/r";

const project = projectSchema.parse({
  id: PROJECT,
  name: "Demo",
  repoUrl: REPO_URL,
  defaultBranch: "main",
  settings: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

function pr(number: number, title: string): PullRequest {
  return {
    projectId: PROJECT,
    number,
    title,
    state: "open",
    ciStatus: "unknown",
    reviewState: "none",
    headBranch: "feature",
    baseBranch: "main",
    author: "eric",
    url: `${REPO_URL}/pull/${number}`,
    updatedAt: "2026-09-06T12:00:00Z",
  };
}

function issueNode(number: number, title: string) {
  return {
    number,
    title,
    url: `${REPO_URL}/issues/${number}`,
    updatedAt: "2026-09-06T12:00:00Z",
    assignees: { nodes: [] },
    blockedBy: { nodes: [] },
  };
}

/** GraphQL issues query over the fake gh runner; reads `issues()` each call.
 * `failNext` fails exactly the next call (armed once), not "the first ever". */
function fakeGh(readIssues: () => { number: number; title: string }[], failNext: { armed: boolean }) {
  let calls = 0;
  const runner: GhRunner = async (args) => {
    calls++;
    if (failNext.armed) {
      failNext.armed = false;
      throw new Error("gh exploded");
    }
    if (args[0] !== "api" || args[1] !== "graphql") throw new Error(`unexpected args: ${JSON.stringify(args)}`);
    const issues = readIssues();
    return {
      stdout: JSON.stringify({
        data: {
          repository: {
            issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: issues.map((issue) => issueNode(issue.number, issue.title)) },
          },
        },
      }),
      stderr: "",
    };
  };
  return {
    gh: () => new GhClient(runner),
    ghCalls: () => calls,
  };
}

interface Harness {
  service: KanbanService;
  /** Advances the fake clock. */
  advance: (ms: number) => void;
  /** gh GraphQL invocations so far. */
  ghCalls: () => number;
  /** Replaces the served issues (next fetch). */
  serveIssues: (issues: { number: number; title: string }[]) => void;
  /** Makes the next gh call fail once. */
  failNext: () => void;
}

function harness(ttlMs = 30_000, onBoardRefreshed?: (projectId: string) => void): Harness {
  let now = 1_000_000;
  let issues = [{ number: 1, title: "First" }];
  const failNext = { armed: false };
  const fake = fakeGh(
    () => issues,
    failNext,
  );
  const service = new KanbanService({
    gh: fake.gh,
    listWorkers: () => [],
    listPullRequests: async () => [pr(9, "PR 9")],
    ttlMs,
    now: () => now,
    onBoardRefreshed,
  });
  return {
    service,
    advance: (ms) => {
      now += ms;
    },
    ghCalls: fake.ghCalls,
    serveIssues: (next) => {
      issues = next;
    },
    failNext: () => {
      failNext.armed = true;
    },
  };
}

async function cardTitles(board: KanbanBoard): Promise<string[]> {
  return board.columns.flatMap((column) => column.cards.map((card) => card.title));
}

describe("KanbanService board cache", () => {
  it("fetches once and serves repeat calls from the TTL cache with zero gh calls", async () => {
    const h = harness();
    const first = await h.service.getBoard(project);
    await expect(cardTitles(first)).resolves.toEqual(["First", "PR 9"]);
    expect(h.ghCalls()).toBe(1);
    await h.service.getBoard(project);
    await h.service.getBoard(project);
    expect(h.ghCalls()).toBe(1);
  });

  it("stale-while-revalidate: serves the stale board immediately, refreshes in background", async () => {
    const h = harness();
    await h.service.getBoard(project);
    h.advance(30_001);
    h.serveIssues([{ number: 2, title: "Second" }]);
    const stale = await h.service.getBoard(project);
    await expect(cardTitles(stale)).resolves.toEqual(["First", "PR 9"]);
    // Let the single-flight background refresh settle, then re-read.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.ghCalls()).toBe(2);
    const fresh = await h.service.getBoard(project);
    await expect(cardTitles(fresh)).resolves.toEqual(["Second", "PR 9"]);
    expect(h.ghCalls()).toBe(2);
  });

  it("keeps the stale board when the background refresh fails", async () => {
    const h = harness();
    await h.service.getBoard(project);
    h.advance(30_001);
    h.failNext();
    const stale = await h.service.getBoard(project);
    await expect(cardTitles(stale)).resolves.toEqual(["First", "PR 9"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.ghCalls()).toBe(2);
    await expect(cardTitles(await h.service.getBoard(project))).resolves.toEqual(["First", "PR 9"]);
  });

  it("propagates errors on the initial fetch (nothing to serve stale)", async () => {
    const h = harness();
    h.failNext();
    await expect(h.service.getBoard(project)).rejects.toThrow("gh exploded");
    // A later call retries instead of caching the failure.
    await expect(cardTitles(await h.service.getBoard(project))).resolves.toEqual(["First", "PR 9"]);
  });

  it("coalesces concurrent stale reads into a single background refresh", async () => {
    const h = harness();
    await h.service.getBoard(project);
    h.advance(30_001);
    h.serveIssues([{ number: 2, title: "Second" }]);
    await Promise.all([h.service.getBoard(project), h.service.getBoard(project)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.ghCalls()).toBe(2);
  });

  it("serves different projects and repo URLs independently", async () => {
    const h = harness();
    const other = { ...project, id: "other", repoUrl: "https://github.com/o/other" };
    await h.service.getBoard(project);
    await h.service.getBoard(other);
    expect(h.ghCalls()).toBe(2);
    await h.service.getBoard(project);
    await h.service.getBoard(other);
    expect(h.ghCalls()).toBe(2);
  });

  it("drops a project's boards on invalidate", async () => {
    const h = harness();
    await h.service.getBoard(project);
    h.service.invalidate(PROJECT);
    await h.service.getBoard(project);
    expect(h.ghCalls()).toBe(2);
  });

  it("reports board revalidations — but not cold fills or fresh hits (issue #451)", async () => {
    const refreshed: string[] = [];
    const h = harness(30_000, (projectId) => refreshed.push(projectId));

    // Cold fill: the fetching client just got this board — no push.
    await h.service.getBoard(project);
    expect(refreshed).toEqual([]);

    // Fresh hit inside the TTL: 0 fetches, 0 pushes.
    await h.service.getBoard(project);
    expect(refreshed).toEqual([]);

    // Stale revalidation: the push fires when the background refresh
    // COMPLETES (fresh data exists that clients render stale) — not when
    // the stale value is served.
    h.advance(30_001);
    h.serveIssues([{ number: 2, title: "Second" }]);
    await h.service.getBoard(project); // resolves with the stale board
    expect(refreshed).toEqual([]); // refresh still in flight
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshed).toEqual([PROJECT]);

    // A failed revalidation pushes nothing — the stale value stays.
    h.advance(30_001);
    h.failNext();
    await h.service.getBoard(project);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshed).toEqual([PROJECT]);
  });
});

// ---------------------------------------------------------------------------
// deriveBoard column derivation (issue #102: archived workers)
// ---------------------------------------------------------------------------

describe("deriveBoard: archived workers (issue #102)", () => {
  const UPDATED_AT = "2026-01-01T00:00:00.000Z";
  const boardProject = projectSchema.parse({
    id: "o-r",
    name: "o-r",
    repoUrl: "https://github.com/o/r",
    defaultBranch: "main",
    settings: {},
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
  });
  const issue = {
    projectId: "o-r",
    number: 5,
    title: "Worked",
    state: "open" as const,
    blockedBy: [],
    assignee: null,
    url: "https://github.com/o/r/issues/5",
    updatedAt: UPDATED_AT,
  };
  const worker = (status: "running" | "archived") => ({
    id: `worker-${status}`,
    projectId: "o-r",
    sessionId: `sess-${status}`,
    issueNumber: 5,
    prNumbers: [],
    status,
    statusMessage: null,
    startedAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
  });
  const card = (workers: Parameters<typeof deriveBoard>[3]) =>
    deriveBoard(boardProject, [issue], [], workers).columns.find((c) => c.column === "in_progress")?.cards[0];

  it("a live worker drives its issue card (in_progress, workerId set)", () => {
    expect(card([worker("running")])).toMatchObject({ workerId: "worker-running", column: "in_progress" });
  });

  it("an archived worker does not: the unassigned issue falls back to backlog", () => {
    expect(card([worker("archived")])).toBeUndefined();
    const backlog = deriveBoard(boardProject, [issue], [], [worker("archived")]).columns.find(
      (c) => c.column === "backlog",
    )?.cards[0];
    expect(backlog).toMatchObject({ workerId: null, column: "backlog" });
  });
});

// ---------------------------------------------------------------------------
// deriveBoard card URL + diff counts (issue #261)
// ---------------------------------------------------------------------------

describe("deriveBoard: card url + diff counts (issue #261)", () => {
  const updatedAt = "2026-09-06T12:00:00Z";
  const boardProject = projectSchema.parse({
    id: PROJECT,
    name: "Demo",
    repoUrl: REPO_URL,
    defaultBranch: "main",
    settings: {},
    createdAt: updatedAt,
    updatedAt,
  });
  const issue = {
    projectId: PROJECT,
    number: 5,
    title: "Worked",
    state: "open" as const,
    blockedBy: [],
    assignee: null,
    url: `${REPO_URL}/issues/5`,
    updatedAt,
  };
  const cards = (prs: PullRequest[]) => deriveBoard(boardProject, [issue], prs, []).columns.flatMap((c) => c.cards);

  it("issue cards carry the issue URL and no diff counts", () => {
    const card = cards([]).find((c) => c.kind === "issue");
    expect(card?.url).toBe(`${REPO_URL}/issues/5`);
    expect(card?.additions).toBeUndefined();
    expect(card?.deletions).toBeUndefined();
  });

  it("PR cards carry the PR URL and the payload's +/- diff counts", () => {
    const card = cards([{ ...pr(18, "Counts"), additions: 120, deletions: 3 }]).find((c) => c.kind === "pull_request");
    expect(card?.url).toBe(`${REPO_URL}/pull/18`);
    expect(card?.additions).toBe(120);
    expect(card?.deletions).toBe(3);
  });

  it("PR cards without resolved diff totals omit the counts (event-derived PRs)", () => {
    const card = cards([pr(19, "No counts yet")]).find((c) => c.kind === "pull_request");
    expect(card?.url).toBe(`${REPO_URL}/pull/19`);
    expect(card?.additions).toBeUndefined();
    expect(card?.deletions).toBeUndefined();
  });
});
