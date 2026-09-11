/**
 * Issue #451 freshness tests for the kanban board cache: the SWR background
 * refresh used to land silently in the daemon cache — the webapp only saw it
 * on its next poll, so navigation showed old state for seconds. Covered
 * here: the navigation `refresh` bypass, the `onBoardChanged` push hook, and
 * the worker-state generation key (worker mutations orphan the cached
 * worker-derived card placement immediately).
 */

import { describe, expect, it } from "vitest";
import { projectSchema, type KanbanBoard } from "@pideck/shared";

import { GhClient, type GhRunner } from "../github/gh.js";
import { KanbanService } from "./kanban.js";

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

/** Minimal GraphQL issues stub; the PR listing is injected directly. */
function ghRunner(readIssues: () => { number: number; title: string }[]): { gh: () => GhClient; calls: () => number } {
  let calls = 0;
  const run: GhRunner = async (args) => {
    calls++;
    if (args[0] !== "api" || args[1] !== "graphql") throw new Error(`unexpected args: ${JSON.stringify(args)}`);
    return {
      stdout: JSON.stringify({
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: readIssues().map((issue) => ({
                number: issue.number,
                title: issue.title,
                url: `${REPO_URL}/issues/${issue.number}`,
                updatedAt: "2026-09-06T12:00:00Z",
                assignees: { nodes: [] },
                blockedBy: { nodes: [] },
              })),
            },
          },
        },
      }),
      stderr: "",
    };
  };
  return { gh: () => new GhClient(run), calls: () => calls };
}

/** Service with an injectable clock, change hook, and worker-state version. */
function service(opts: {
  issues?: () => { number: number; title: string }[];
  now?: () => number;
  onBoardChanged?: (board: KanbanBoard) => void;
  listWorkersVersion?: () => number;
}) {
  const fake = ghRunner(opts.issues ?? (() => [{ number: 1, title: "First" }]));
  let now = 1_000_000;
  const svc = new KanbanService({
    gh: fake.gh,
    listWorkers: () => [],
    listPullRequests: async () => [],
    ttlMs: 30_000,
    now: opts.now ?? (() => now),
    ...(opts.onBoardChanged === undefined ? {} : { onBoardChanged: opts.onBoardChanged }),
    ...(opts.listWorkersVersion === undefined ? {} : { listWorkersVersion: opts.listWorkersVersion }),
  });
  return {
    svc,
    ghCalls: fake.calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function cardTitles(board: KanbanBoard): Promise<string[]> {
  return board.columns.flatMap((column) => column.cards.map((card) => card.title));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("KanbanService freshness (issue #451)", () => {
  it("refresh bypasses the cache and the fresh fetch becomes the new entry", async () => {
    const issues = [{ number: 1, title: "First" }];
    const h = service({ issues: () => issues });
    await h.svc.getBoard(project);
    expect(h.ghCalls()).toBe(1);
    issues[0] = { number: 2, title: "Second" };
    const fresh = await h.svc.getBoard(project, { refresh: true });
    await expect(cardTitles(fresh)).resolves.toEqual(["Second"]);
    expect(h.ghCalls()).toBe(2);
    await h.svc.getBoard(project); // the fresh fetch is now the cache entry
    expect(h.ghCalls()).toBe(2);
  });

  it("announces a background refresh that re-derived a different board", async () => {
    const seen: KanbanBoard[] = [];
    const issues = [{ number: 1, title: "First" }];
    const h = service({ issues: () => issues, onBoardChanged: (board) => seen.push(board) });
    await h.svc.getBoard(project);
    h.advance(30_001);
    issues[0] = { number: 2, title: "Second" };
    await h.svc.getBoard(project); // stale served, background refresh kicked
    await settle();
    expect(seen).toHaveLength(1);
    await expect(cardTitles(seen[0]!)).resolves.toEqual(["Second"]);
  });

  it("does not announce a background refresh that re-derived the same board", async () => {
    const seen: KanbanBoard[] = [];
    const h = service({ onBoardChanged: (board) => seen.push(board) });
    await h.svc.getBoard(project);
    h.advance(30_001);
    await h.svc.getBoard(project);
    await settle();
    expect(seen).toEqual([]);
  });

  it("keys the cache on the worker-state generation: a worker mutation forces a re-fetch", async () => {
    let workersVersion = 0;
    const h = service({ listWorkersVersion: () => workersVersion });
    await h.svc.getBoard(project);
    expect(h.ghCalls()).toBe(1);
    await h.svc.getBoard(project); // fresh hit — still one fetch
    expect(h.ghCalls()).toBe(1);
    workersVersion += 1; // a worker spawned / changed status daemon-side
    await h.svc.getBoard(project); // new cache key → cold re-fetch
    expect(h.ghCalls()).toBe(2);
  });
});