/**
 * Derives kanban board state from domain entities.
 *
 * Card movement is entirely a function of entity state (issue state/assignee,
 * PR state/CI/review) — never of user drag. The webapp renders whatever
 * `deriveBoard` produces, so issue #13 can drive the same derivation from
 * live websocket events.
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

/** Human-readable column labels, keyed by shared `KanbanColumn`. */
export const COLUMN_LABELS: Record<KanbanColumn, string> = {
  backlog: "Backlog",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
};

/** Which column an issue belongs to. */
export function issueColumn(issue: Issue, worker: Worker | undefined): KanbanColumn {
  if (issue.state === "closed") return "done";
  // Actively driven (assigned to an agent/worker) means work has started.
  return worker || issue.assignee ? "in_progress" : "backlog";
}

/** Which column a pull request belongs to. */
export function pullRequestColumn(pr: PullRequest): KanbanColumn {
  if (pr.state === "merged" || pr.state === "closed") return "done";
  const ciSettled = pr.ciStatus === "success" || pr.ciStatus === "failure";
  // A PR that has been pushed for CI/review sits in "In Review".
  return ciSettled || pr.reviewState !== "none" ? "in_review" : "in_progress";
}

function maxUpdatedAt(cards: readonly KanbanCard[], fallback: string): string {
  let max = fallback;
  for (const card of cards) {
    if (card.updatedAt > max) max = card.updatedAt;
  }
  return max;
}

/**
 * Builds the full board for one project from its domain entities.
 * Entities are filtered to the project's, so callers may pass whole-store
 * collections. Issues and PRs are independent cards; both flow through the
 * same columns.
 */
export function deriveBoard(
  project: Project,
  allIssues: readonly Issue[],
  allPullRequests: readonly PullRequest[],
  allWorkers: readonly Worker[],
): KanbanBoard {
  const issues = allIssues.filter((issue) => issue.projectId === project.id);
  const pullRequests = allPullRequests.filter((pr) => pr.projectId === project.id);
  const workers = allWorkers.filter((worker) => worker.projectId === project.id);
  const workerByIssue = new Map<number, Worker>();
  for (const worker of workers) {
    if (worker.prNumber === null) workerByIssue.set(worker.issueNumber, worker);
  }

  const cards: KanbanCard[] = [];

  for (const issue of issues) {
    const worker = workerByIssue.get(issue.number);
    cards.push({
      id: `issue-${project.id}-${issue.number}`,
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
      id: `pull_request-${project.id}-${pr.number}`,
      projectId: project.id,
      kind: "pull_request",
      number: pr.number,
      title: pr.title,
      column: pullRequestColumn(pr),
      workerId: null,
      updatedAt: pr.updatedAt,
    });
  }

  const columns = KANBAN_COLUMNS.map((column) => ({
    column,
    cards: cards.filter((card) => card.column === column),
  }));

  return {
    projectId: project.id,
    updatedAt: maxUpdatedAt(cards, project.updatedAt),
    columns,
  };
}
