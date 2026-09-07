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
 */

import {
  KANBAN_COLUMNS,
  type Issue,
  type KanbanBoard,
  type KanbanCard,
  type KanbanColumn,
  type Project,
  type PullRequest,
  type Worker,
} from "@agentskiss/shared";

import { fetchIssuesWithBlockedBy, listPullRequestsWithMeta, parseRepoUrl, type GhClient } from "../github/index.js";
import { issueCardId } from "../pipeline/issues/pipeline.js";
import { prCardId } from "../pipeline/prs/tracker.js";

// ---------------------------------------------------------------------------
// Column derivation (single source of truth — the PR pipeline reuses these)
// ---------------------------------------------------------------------------

export function issueColumn(issue: Issue, worker: Worker | undefined): KanbanColumn {
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
  const workerByIssue = new Map<number, Worker>();
  for (const worker of workers) {
    if (worker.prNumber === null) workerByIssue.set(worker.issueNumber, worker);
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
}

export class KanbanService {
  private readonly gh: (repoUrl: string) => GhClient;
  private readonly listWorkers: () => Worker[];
  private readonly listPullRequests?: (project: Project) => Promise<PullRequest[]>;

  constructor(deps: KanbanServiceDeps) {
    this.gh = deps.gh;
    this.listWorkers = deps.listWorkers;
    this.listPullRequests = deps.listPullRequests;
  }

  /** Fetches the project's GitHub entities and derives the board. */
  async getBoard(project: Project): Promise<KanbanBoard> {
    const gh = this.gh(project.repoUrl);
    const repo = parseRepoUrl(project.repoUrl);
    const pullRequests = await (this.listPullRequests?.(project) ?? listPullRequestsWithMeta(gh, project.id, repo));
    const issues = await fetchIssuesWithBlockedBy(gh, project.id, repo);
    return deriveBoard(project, issues, pullRequests, this.listWorkers());
  }
}
