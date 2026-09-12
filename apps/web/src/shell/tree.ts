/**
 * Sidebar tree model: turns the flat project + SessionView lists into the
 * nested shape the sidebar renders — global agent on top, then per project
 * the orchestrator, workers ordered by issue with their reviewers nested
 * beneath them, and archived sessions in their own group. Live reviewers
 * whose worker is not in the list are dropped (the daemon removes a reviewer
 * together with its worker). Also home to the row-text helpers shared by the
 * sidebar and the header, and the GitHub deep links.
 */

import type { Project, SessionView } from "@pideck/shared";

/** One live worker with the reviewers nested under it. */
interface WorkerNode {
  view: SessionView;
  reviewers: SessionView[];
}

/** A project's slice of the sidebar tree. */
export interface ProjectNode {
  project: Project;
  orchestrator: SessionView | null;
  workers: WorkerNode[];
  archived: SessionView[];
  /** Set when the review account cannot read this project's repo. */
  reviewAccess: string | null;
}

/** The full tree: the global agent row on top, then one node per project. */
export interface SidebarTree {
  globalAgent: SessionView | null;
  projects: ProjectNode[];
}

const bySpawnedAt = (a: SessionView, b: SessionView): number =>
  a.session.spawnedAt.localeCompare(b.session.spawnedAt);

const byIssueThenSpawn = (a: SessionView, b: SessionView): number =>
  (a.session.issueNumber ?? Number.POSITIVE_INFINITY) - (b.session.issueNumber ?? Number.POSITIVE_INFINITY) ||
  bySpawnedAt(a, b);

const byArchivedDesc = (a: SessionView, b: SessionView): number =>
  (b.session.archivedAt ?? "").localeCompare(a.session.archivedAt ?? "");

export function buildTree(projects: Project[], views: SessionView[]): SidebarTree {
  const nodes = new Map<string, ProjectNode>();
  for (const project of projects) {
    nodes.set(project.id, { project, orchestrator: null, workers: [], archived: [], reviewAccess: null });
  }

  let globalAgent: SessionView | null = null;
  const live = new Map<string, SessionView[]>();
  for (const view of views) {
    if (view.session.persona === "global") {
      if (globalAgent === null || (globalAgent.session.archivedAt !== undefined && view.session.archivedAt === undefined)) {
        globalAgent = view;
      }
      continue;
    }
    const projectId = view.session.projectId;
    const node = projectId === null ? undefined : nodes.get(projectId);
    if (node === undefined) continue;
    // The review-access fact is per project; any session of the project
    // carries it.
    if (node.reviewAccess === null && view.reviewAccess !== null) node.reviewAccess = view.reviewAccess;
    if (view.session.archivedAt !== undefined) {
      node.archived.push(view);
    } else {
      const bucket = live.get(projectId ?? "");
      if (bucket === undefined) live.set(projectId ?? "", [view]);
      else bucket.push(view);
    }
  }

  for (const node of nodes.values()) {
    const mine = live.get(node.project.id) ?? [];
    node.orchestrator = mine.find((view) => view.session.persona === "orchestrator") ?? null;
    const reviewers = mine.filter((view) => view.session.persona === "reviewer");
    node.workers = mine
      .filter((view) => view.session.persona === "worker")
      .sort(byIssueThenSpawn)
      .map((view) => ({
        view,
        reviewers: reviewers
          .filter((candidate) => candidate.parentSessionId === view.session.id)
          .sort(bySpawnedAt),
      }));
    node.archived.sort(byArchivedDesc);
  }

  return { globalAgent, projects: [...nodes.values()] };
}

export interface RowText {
  num: string | null;
  glyph: string | null;
  label: string;
}

/** What one session row shows: blue issue number, reviewer glyph, label. */
export function sessionRow(view: SessionView): RowText {
  switch (view.session.persona) {
    case "global":
      return { num: null, glyph: null, label: "Global agent" };
    case "orchestrator":
      return { num: null, glyph: null, label: "Orchestrator" };
    case "worker": {
      if (view.session.label !== undefined) {
        return { num: null, glyph: null, label: view.session.label };
      }
      return {
        num: view.session.issueNumber !== undefined ? `#${view.session.issueNumber}` : null,
        glyph: null,
        label: view.title ?? view.status,
      };
    }
    case "reviewer":
      return {
        num: null,
        glyph: "↳",
        label: view.session.label ?? view.title ?? (view.status === "" ? "Reviewer" : view.status),
      };
  }
}

/** The row's plain text, for ellipsis titles and the header context. */
export function rowText(view: SessionView): string {
  const row = sessionRow(view);
  return row.num === null ? row.label : `${row.num} ${row.label}`;
}

export interface GithubLink {
  label: string;
  url: string;
}

/** Deep links to the session's issue and PR, in that order. */
export function githubLinks(project: Project, view: SessionView): GithubLink[] {
  const base = `https://github.com/${project.owner}/${project.repo}`;
  const links: GithubLink[] = [];
  if (view.session.issueNumber !== undefined) {
    links.push({
      label: `Open issue #${view.session.issueNumber}`,
      url: `${base}/issues/${view.session.issueNumber}`,
    });
  }
  if (view.session.prNumber !== undefined) {
    links.push({
      label: `Open PR #${view.session.prNumber}`,
      url: `${base}/pull/${view.session.prNumber}`,
    });
  }
  return links;
}
