/**
 * Kanban state per project: derives the shared `KanbanBoard` from live
 * GitHub entities (issues + PRs with CI/review metadata, via the github
 * module) and the session registry's workers.
 *
 * Column placement is **server-derived**: this module owns the issue/PR →
 * column rules and pushes card moves over `/api/ws`; the webapp renders
 * whatever board it receives (apps/web/src/lib/kanban.ts).
 * - issues: closed → `done`; has an assignee or a live worker → `in_progress`; else `backlog`.
 * - PRs: merged/closed → `done`; settled CI or any review decision → `in_review`; else `in_progress`.
 *
 * Boards are TTL-cached with stale-while-revalidate (issue #88): the webapp
 * polls this endpoint, and every call used to cost GitHub GraphQL queries —
 * a webapp request storm became an upstream storm. Shared TTL+SWR cache
 * (`TtlSwrCache`); same economy as the PR listing cache (issue #40):
 * fresh → 0 gh calls; stale → serve immediately + at most one single-flight
 * background refresh per project.
 */

import {
  KANBAN_COLUMNS,
  issueCardId,
  prCardId,
  type Issue,
  type KanbanBoard,
  type KanbanCard,
  type KanbanColumn,
  type Project,
  type PullRequest,
  type Worker,
} from "@pideck/shared";

import { fetchIssuesWithBlockedBy, listPullRequestsWithMeta, parseRepoUrl, type GhClient } from "../github/index.js";
import { TtlSwrCache } from "./swr-cache.js";

// ---------------------------------------------------------------------------
// Column derivation (single source of truth — the PR pipeline reuses these)
// ---------------------------------------------------------------------------

function issueColumn(issue: Issue, worker: Worker | undefined): KanbanColumn {
  if (issue.state === "closed") return "done";
  return worker !== undefined || issue.assignee !== null ? "in_progress" : "backlog";
}

/**
 * PR → kanban column: the one rule set, also used by the PR pipeline when
 * emitting card events (pipeline/prs/pipeline.ts).
 */
export function pullRequestColumn(pr: PullRequest): KanbanColumn {
  if (pr.state === "merged" || pr.state === "closed") return "done";
  const ciSettled = pr.ciStatus === "success" || pr.ciStatus === "failure";
  return ciSettled || pr.reviewState !== "none" ? "in_review" : "in_progress";
}

function maxUpdatedAt(cards: readonly KanbanCard[], fallback: string): string {
  let max = fallback;
  for (const card of cards) {
    if (card.updatedAt > max) max = card.updatedAt;
  }
  return max;
}

/** Pure board derivation from a project's entities (no I/O — directly testable). */
export function deriveBoard(
  project: Project,
  issues: readonly Issue[],
  pullRequests: readonly PullRequest[],
  workers: readonly Worker[],
): KanbanBoard {
  // Archived workers (issue #102) no longer drive their issue: they must not
  // pull it into `in_progress` or show as the card's worker — the issue falls
  // back to the assignee-based column rules.
  const workerByIssue = new Map<number, Worker>();
  for (const worker of workers) {
    if (worker.status === "archived") continue;
    if (worker.prNumbers.length === 0) workerByIssue.set(worker.issueNumber, worker);
  }

  const cards: KanbanCard[] = [];
  for (const issue of issues) {
    const worker = workerByIssue.get(issue.number);
    cards.push({
      id: issueCardId(project.id, issue.number),
      projectId: project.id,
      kind: "issue",
      number: issue.number,
      title: issue.title,
      column: issueColumn(issue, worker),
      workerId: worker?.id ?? null,
      updatedAt: issue.updatedAt,
      // Issue #261: issues are linkable; no diff counts exist for issues.
      url: issue.url,
    });
  }
  for (const pr of pullRequests) {
    cards.push({
      id: prCardId(project.id, pr.number),
      projectId: project.id,
      kind: "pull_request",
      number: pr.number,
      title: pr.title,
      column: pullRequestColumn(pr),
      workerId: null,
      updatedAt: pr.updatedAt,
      // Issue #261: linkability + diff counts where the data exists.
      url: pr.url,
      ...(pr.additions !== undefined && pr.deletions !== undefined
        ? { additions: pr.additions, deletions: pr.deletions }
        : {}),
    });
  }

  return {
    projectId: project.id,
    updatedAt: maxUpdatedAt(cards, project.updatedAt),
    columns: KANBAN_COLUMNS.map((column) => ({
      column,
      cards: cards.filter((card) => card.column === column),
    })),
  };
}

// ---------------------------------------------------------------------------
// Service (I/O over the github module)
// ---------------------------------------------------------------------------

export interface KanbanServiceDeps {
  /** GhClient factory keyed by repo URL; overridable in tests. */
  gh: (repoUrl: string) => GhClient;
  /** Live worker list (usually `SessionManager.listWorkers`). */
  listWorkers: () => Worker[];
  /**
   * Batched + TTL-cached open-PR listing (issue #40). Defaults to the
   * uncached REST + per-PR enrichment flow for direct constructions.
   */
  listPullRequests?: (project: Project) => Promise<PullRequest[]>;
  /** Board cache TTL in ms (issue #88). Default 30_000. */
  ttlMs?: number;
  /** Injectable clock (ms epoch; tests). */
  now?: () => number;
  /**
   * Issue #451: called after a REVALIDATION fetch completes — a board whose
   * cached copy was stale got refreshed. The API layer broadcasts
   * `kanban.board.updated` on the hub so connected webapps reload
   * immediately instead of rendering the stale value until their next poll.
   * The first (cold) fill is not reported: the fetching client just got
   * that board, and a push would only trigger a redundant reload.
   */
  onBoardRefreshed?: (projectId: string) => void;
}

export class KanbanService {
  private readonly gh: (repoUrl: string) => GhClient;
  private readonly listWorkers: () => Worker[];
  private readonly listPullRequests?: (project: Project) => Promise<PullRequest[]>;
  private readonly onBoardRefreshed?: (projectId: string) => void;
  /**
   * Board cache per project+repo (issue #88): `getProjectKanban` used to hit
   * GitHub GraphQL on every call, so the webapp's poll cadence (and any
   * request storm) became an upstream storm. Shared TTL+SWR cache
   * (see `TtlSwrCache`); same economy as the PR listing cache (issue #40).
   */
  private readonly boards: TtlSwrCache<KanbanBoard>;

  constructor(deps: KanbanServiceDeps) {
    this.gh = deps.gh;
    this.listWorkers = deps.listWorkers;
    this.listPullRequests = deps.listPullRequests;
    this.onBoardRefreshed = deps.onBoardRefreshed;
    this.boards = new TtlSwrCache<KanbanBoard>({
      ttlMs: deps.ttlMs,
      now: deps.now,
      // Issue #451: a completed background revalidation means fresh board
      // data exists that connected webapps are still rendering stale — the
      // API layer broadcasts `kanban.board.updated` so they reload at once.
      onRefresh: (key) => this.onBoardRefreshed?.(key.split("\n")[0] ?? ""),
    });
  }

  /** The project's kanban board, TTL-cached with stale-while-revalidate. */
  async getBoard(project: Project): Promise<KanbanBoard> {
    return this.boards.get(cacheKey(project.id, project.repoUrl), () => this.fetchBoard(project));
  }

  /** Drops cached boards (all, or one project's) — e.g. for tests. */
  invalidate(projectId?: string): void {
    this.boards.invalidate(projectId === undefined ? undefined : `${projectId}\n`);
  }

  /** Fetches the project's GitHub entities and derives the board. */
  private async fetchBoard(project: Project): Promise<KanbanBoard> {
    const gh = this.gh(project.repoUrl);
    const repo = parseRepoUrl(project.repoUrl);
    const pullRequests = await (this.listPullRequests?.(project) ?? listPullRequestsWithMeta(gh, project.id, repo));
    const issues = await fetchIssuesWithBlockedBy(gh, project.id, repo);
    return deriveBoard(project, issues, pullRequests, this.listWorkers());
  }
}

/** Cache key: project + repo (a repoUrl change must not be served stale values of the old repo). */
function cacheKey(projectId: string, repoUrl: string): string {
  return `${projectId}\n${repoUrl}`;
}
