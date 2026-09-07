/**
 * Issue operations: REST list/mapping onto the shared {@link Issue} contract,
 * and native blocked-by resolution.
 *
 * Blocked-by shape, verified against the live GitHub API (2026-09, probe repo
 * with real `addBlockedBy` relationships):
 * - REST has **no** relationship endpoint (`GET .../issues/:n/relationships`
 *   → 404). REST only exposes `issue_dependencies_summary` *counts*, which
 *   also only cover open blockers.
 * - GraphQL `Issue.blockedBy(first:, after:)` is the real source: an
 *   `IssueConnection` (`totalCount`, `pageInfo{hasNextPage,endCursor}`,
 *   `nodes[] { number, state, title, url, updatedAt, repository{nameWithOwner} ... }`).
 * - The connection **includes CLOSED blockers**; only `state: OPEN` ones
 *   actually block, so filtering happens client-side here.
 * - Blockers may be cross-repository (nodes carry `repository.nameWithOwner`);
 *   same-repo open blockers map to the shared contract's `blockedBy: number[]`.
 */

import { z } from "zod";
import { issueSchema, type Issue, type RefNumber } from "@agentskiss/shared";

import { formatRepoRef, type GhClient, type RepoRef } from "./gh.js";

// ---------------------------------------------------------------------------
// REST list + mapping
// ---------------------------------------------------------------------------

const restIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  user: z.object({ login: z.string() }).nullable(),
  assignee: z.object({ login: z.string() }).nullable(),
  assignees: z.array(z.object({ login: z.string() })),
  html_url: z.string().url(),
  updated_at: z.string(),
  pull_request: z.unknown().optional(),
});

/** A GitHub issue as returned by the REST list, plus watcher-relevant fields. */
export interface IssueRecord {
  /** Shared-contract view of the issue (`blockedBy` not resolved here — see {@link resolveBlockedBy}). */
  issue: Issue;
  /** Login of the issue author. */
  author: string | null;
  /** Logins of all assignees. */
  assignees: string[];
}

/** Maps one REST issue payload; returns `null` for PR entries (they appear in the issues list too). */
export function mapRestIssue(projectId: string, raw: unknown): IssueRecord | null {
  const parsed = restIssueSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  // The REST issues endpoint also returns pull requests; skip those.
  if (r.pull_request !== undefined) return null;
  const primaryAssignee = r.assignee?.login ?? r.assignees[0]?.login ?? null;
  const issue = issueSchema.parse({
    projectId,
    number: r.number,
    title: r.title,
    state: r.state,
    blockedBy: [],
    assignee: primaryAssignee,
    url: r.html_url,
    updatedAt: r.updated_at,
  });
  return { issue, author: r.user?.login ?? null, assignees: r.assignees.map((a) => a.login) };
}

export interface ListIssuesOptions {
  state?: "open" | "closed" | "all";
}

/** Options for {@link listIssuesCreatedAfter}. */
export interface ListIssuesCreatedAfterOptions {
  /** Only issues with a number strictly greater than this are returned. */
  afterNumber: number;
  /** Max records returned (the caller's batch size). Default 25. */
  first?: number;
  /** Max REST pages fetched per call. Default 10. */
  maxPages?: number;
}

/** REST page size used while paging toward the cursor boundary. */
const CREATED_AFTER_PAGE_SIZE = 100;

/**
 * Fetches the **oldest open issues numbered strictly after** `afterNumber`,
 * in ascending issue order, bounded: at most `first` records are returned
 * and at most `maxPages` REST pages are fetched per call.
 *
 * The catch-up sweep (issue #50) uses this to fetch the issues created while
 * the daemon was down. Paging runs **newest-first** (`sort=created`,
 * `direction=desc`) so the records after the cursor sit near page 1 even in
 * a repo with a huge old backlog; paging stops as soon as a record at or
 * before the cursor appears — issue numbers are assigned in creation order,
 * so everything after it in a newest-first page is older. Because the sweep
 * must process the **oldest** issues above the cursor first, the whole
 * window above the cursor (≤ `maxPages` pages) is collected and sliced.
 * Closed issues and PR entries are absent from / skipped in the
 * open-issues list, which keeps the number monotonicity the early-stop
 * relies on. Records repeated across pages (or by a fake gh that ignores
 * the page param) are deduplicated.
 */
export async function listIssuesCreatedAfter(
  gh: GhClient,
  projectId: string,
  repo: RepoRef,
  options: ListIssuesCreatedAfterOptions,
): Promise<IssueRecord[]> {
  const { afterNumber, first = 25, maxPages = 10 } = options;
  const collected = new Map<number, IssueRecord>();
  outer: for (let page = 1; page <= maxPages; page++) {
    const path =
      `/repos/${repo.owner}/${repo.repo}/issues?state=open&sort=created&direction=desc` +
      `&per_page=${CREATED_AFTER_PAGE_SIZE}&page=${page}`;
    const raw = await gh.apiJson<unknown[]>(path);
    let sawNewRecord = false;
    for (const item of raw) {
      const number = (item as { number?: unknown }).number;
      if (typeof number === "number" && number <= afterNumber) break outer; // passed the cursor boundary
      const record = mapRestIssue(projectId, item);
      if (record === null) continue; // PR entry (or malformed)
      if (!collected.has(record.issue.number)) {
        collected.set(record.issue.number, record);
        sawNewRecord = true;
      }
    }
    // Short page (end of list) or nothing new on this page: stop paging.
    if (!sawNewRecord || raw.length < CREATED_AFTER_PAGE_SIZE) break;
  }
  return [...collected.values()]
    .sort((a, b) => a.issue.number - b.issue.number) // oldest first
    .slice(0, first);
}

/** Lists repository issues (excluding PRs) via REST. */
export async function listIssues(gh: GhClient, projectId: string, repo: RepoRef, options: ListIssuesOptions = {}): Promise<IssueRecord[]> {
  const state = options.state ?? "open";
  const path = `/repos/${repo.owner}/${repo.repo}/issues?state=${state}&sort=updated&direction=desc`;
  const raw = await gh.apiList<unknown>(path);
  return raw.map((r) => mapRestIssue(projectId, r)).filter((r): r is IssueRecord => r !== null);
}

// ---------------------------------------------------------------------------
// GraphQL: all issues with their open blockers in one request
// ---------------------------------------------------------------------------

const graphqlIssuesQuery = `
query($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $after, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        url
        updatedAt
        assignees(first: 10) { nodes { login } }
        blockedBy(first: 100) {
          nodes { number state repository { nameWithOwner } }
        }
      }
    }
  }
}
` as const;

const graphqlIssuesSchema = z.object({
  repository: z
    .object({
      issues: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        nodes: z.array(
          z.object({
            number: z.number().int().positive(),
            title: z.string(),
            url: z.string().url(),
            updatedAt: z.string(),
            assignees: z.object({ nodes: z.array(z.object({ login: z.string() })) }),
            blockedBy: z.object({
              nodes: z.array(z.object({ number: z.number().int().positive(), state: z.enum(["OPEN", "CLOSED"]), repository: z.object({ nameWithOwner: z.string() }) })),
            }),
          }),
        ),
      }),
    })
    .nullable(),
});

/**
 * Fetches all open issues of a repo with their **open, same-repo** blockers
 * resolved in a single paginated GraphQL query, returning shared-contract
 * {@link Issue}s (`blockedBy` filled in). Cross-repo and closed blockers are
 * not representable in the shared contract and are omitted here; use
 * {@link resolveBlockedBy} for the full detail on a single issue.
 */
export async function fetchIssuesWithBlockedBy(gh: GhClient, projectId: string, repo: RepoRef): Promise<Issue[]> {
  const owner = repo.owner;
  const name = repo.repo;
  const issues: Issue[] = [];
  let after: string | undefined;
  for (;;) {
    const data = graphqlIssuesSchema.parse(await gh.graphql(graphqlIssuesQuery, { owner, name, first: 100, ...(after ? { after } : {}) }));
    const conn = data.repository;
    if (conn === null) break;
    for (const node of conn.issues.nodes) {
      const assignee = node.assignees.nodes[0]?.login ?? null;
      const blockedBy = node.blockedBy.nodes
        .filter((b) => b.state === "OPEN" && b.repository.nameWithOwner === formatRepoRef(repo))
        .map((b) => b.number);
      issues.push(
        issueSchema.parse({
          projectId,
          number: node.number,
          title: node.title,
          state: "open",
          blockedBy,
          assignee,
          url: node.url,
          updatedAt: node.updatedAt,
        }),
      );
    }
    if (!conn.issues.pageInfo.hasNextPage || conn.issues.pageInfo.endCursor === null) break;
    after = conn.issues.pageInfo.endCursor;
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Blocked-by resolution (single issue) — the one GraphQL query + schema;
// every consumer maps the raw nodes it returns.
// ---------------------------------------------------------------------------

const blockedByQuery = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      blockedBy(first: 100, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { number state repository { nameWithOwner } }
      }
    }
  }
}
` as const;

const blockedByResponseSchema = z.object({
  repository: z
    .object({
      issue: z
        .object({
          blockedBy: z.object({
            totalCount: z.number().int(),
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
            nodes: z.array(
              z.object({
                number: z.number().int().positive(),
                state: z.enum(["OPEN", "CLOSED"]),
                repository: z.object({ nameWithOwner: z.string() }).nullable(),
              }),
            ),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

/** One raw `Issue.blockedBy` node, exactly as GitHub reports it. */
interface BlockedByNode {
  number: RefNumber;
  state: "OPEN" | "CLOSED";
  /** `owner/name` of the repository holding the blocker (`null` if GitHub omits it). */
  repository: string | null;
}

/** Raw paginated `Issue.blockedBy` detail for one issue. */
export interface BlockedByDetail {
  issueNumber: RefNumber;
  /** Every native blocker node — any state, any repository, in API order. */
  blockers: BlockedByNode[];
  /** GitHub's `totalCount` for the connection, regardless of state or repository. */
  totalBlockers: number;
}

/**
 * Fetches the raw `Issue.blockedBy` connection for one issue via GraphQL
 * (paginated). See the module docblock for the verified API shape. This is
 * the single source of the blocked-by query + schema; callers filter/map the
 * raw nodes (e.g. {@link resolveBlockedBy} for open same-repo numbers, the
 * pipeline's `GhBlockerResolver` for full closed/cross-repo detail).
 */
export async function fetchBlockedByDetail(gh: GhClient, repo: RepoRef, issueNumber: RefNumber): Promise<BlockedByDetail> {
  const owner = repo.owner;
  const name = repo.repo;
  let totalBlockers = 0;
  const blockers: BlockedByNode[] = [];
  let after: string | undefined;
  for (;;) {
    const data = blockedByResponseSchema.parse(
      await gh.graphql(blockedByQuery, { owner, name, number: issueNumber, ...(after ? { after } : {}) }),
    );
    const issue = data.repository?.issue;
    if (issue === null || issue === undefined) {
      throw new Error(`Issue #${issueNumber} not found in ${formatRepoRef(repo)}`);
    }
    totalBlockers = issue.blockedBy.totalCount;
    for (const node of issue.blockedBy.nodes) {
      blockers.push({ number: node.number, state: node.state, repository: node.repository?.nameWithOwner ?? null });
    }
    if (!issue.blockedBy.pageInfo.hasNextPage || issue.blockedBy.pageInfo.endCursor === null) break;
    after = issue.blockedBy.pageInfo.endCursor;
  }
  return { issueNumber, blockers, totalBlockers };
}

export interface BlockedByResolution {
  issueNumber: RefNumber;
  /**
   * Numbers of **open blockers in the same repository** — the native
   * "blocked by" relationships that currently keep this issue blocked.
   */
  blockedBy: RefNumber[];
  /** True when at least one open (same-repo) blocker exists. */
  blocked: boolean;
  /** Total number of native blockers, regardless of state or repository. */
  totalBlockers: number;
}

/**
 * Resolves GitHub's native "blocked by" relationships for one issue as
 * open-same-repo blocker numbers, on top of {@link fetchBlockedByDetail}.
 */
export async function resolveBlockedBy(gh: GhClient, repo: RepoRef, issueNumber: RefNumber): Promise<BlockedByResolution> {
  const detail = await fetchBlockedByDetail(gh, repo, issueNumber);
  const ownRepo = formatRepoRef(repo);
  const blockedBy = detail.blockers
    .filter((node) => node.state === "OPEN" && node.repository === ownRepo)
    .map((node) => node.number);
  return { issueNumber, blockedBy, blocked: blockedBy.length > 0, totalBlockers: detail.totalBlockers };
}
