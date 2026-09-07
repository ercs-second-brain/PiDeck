/**
 * Shared entity fixtures for daemon unit tests (issue #73): one canonical
 * `Issue` / `IssueRecord` / `PullRequest` maker and one REST pull payload
 * builder, instead of copy-pasted variants per test file.
 *
 * Defaults describe the canonical test repo `o/r` under project `proj`,
 * authored by `eric`, at `2026-09-06T12:00:00Z`; every field is overridable
 * so tests with different constants (project id, repo, timestamps) bind a
 * thin local wrapper instead of redefining the payload shape.
 */

import type { Issue, PullRequest } from "@agentskiss/shared";

import type { IssueRecord } from "../github/issues.js";

/** The canonical fixture repository: `o/r` under project `proj`, authored by `eric`. */
const REPO_URL = "https://github.com/o/r";

/** Builds a shared-contract {@link Issue} for `o/r` / `proj`. */
export function makeIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    projectId: "proj",
    number,
    title: `Issue ${number}`,
    state: "open",
    blockedBy: [],
    assignee: null,
    url: `${REPO_URL}/issues/${number}`,
    updatedAt: "2026-09-06T12:00:00Z",
    ...overrides,
  };
}

/** Builds an {@link IssueRecord} (issue + watcher-relevant fields). */
export function makeIssueRecord(
  number: number,
  overrides: Partial<{ author: string | null; assignees: string[]; title: string; projectId: string }> = {},
): IssueRecord {
  const issue = makeIssue(number, {
    ...(overrides.title !== undefined ? { title: overrides.title } : {}),
    ...(overrides.projectId !== undefined ? { projectId: overrides.projectId } : {}),
    assignee: overrides.assignees?.[0] ?? null,
  });
  return {
    issue,
    author: overrides.author ?? "eric",
    assignees: overrides.assignees ?? [],
  };
}

/** Builds a shared-contract {@link PullRequest} for `o/r` / `proj`. */
export function makePullRequest(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    projectId: "proj",
    number,
    title: `PR ${number}`,
    state: "open",
    ciStatus: "unknown",
    reviewState: "none",
    headBranch: "feature",
    baseBranch: "main",
    author: "eric",
    url: `${REPO_URL}/pull/${number}`,
    updatedAt: "2026-09-06T12:00:00Z",
    ...overrides,
  };
}

/** Overrides for the REST pull payload builder ({@link restPull}). */
export interface RestPullOverrides {
  sha?: string;
  title?: string;
  merged?: boolean;
  closed?: boolean;
  headBranch?: string;
  author?: string;
  updatedAt?: string;
}

/** Builds the REST pull payload in the `mapRestPull` input shape. */
export function restPull(number: number, overrides: RestPullOverrides = {}): Record<string, unknown> {
  return {
    number,
    title: overrides.title ?? `PR ${number}`,
    state: overrides.closed === true ? "closed" : "open",
    merged_at: overrides.merged === true ? "2026-09-06T12:30:00Z" : null,
    user: { login: overrides.author ?? "worker" },
    head: { ref: overrides.headBranch ?? `agent/issue-${number}`, sha: overrides.sha ?? "sha-1" },
    base: { ref: "main" },
    html_url: `${REPO_URL}/pull/${number}`,
    updated_at: overrides.updatedAt ?? "2026-09-06T12:00:00Z",
  };
}
