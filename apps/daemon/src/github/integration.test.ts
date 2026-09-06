/**
 * Integration test — hits the real GitHub API through the local `gh` binary.
 * Skipped entirely when no network token is available (no GH_TOKEN/GITHUB_TOKEN
 * and `gh auth token` yields nothing), e.g. on CI without secrets.
 *
 * All calls are read-only against the ercs-second-brain/agentsKISS repo.
 */

import { describe, expect, it } from "vitest";
import { issueSchema, pullRequestSchema } from "@agentskiss/shared";

import { getAuthStatus, hasGhToken } from "./auth.js";
import { defaultGhRunner, GhClient, parseRepoUrl } from "./gh.js";
import { fetchIssuesWithBlockedBy, listIssues, resolveBlockedBy } from "./issues.js";
import { listPullRequestsWithMeta } from "./pulls.js";

const REPO = parseRepoUrl("https://github.com/ercs-second-brain/agentsKISS");
const PROJECT = "integration-test";

const hasToken = await hasGhToken(defaultGhRunner);
const d = describe.skipIf(!hasToken);

d("integration: GitHub API via gh (requires a token)", () => {
  const gh = new GhClient(defaultGhRunner);

  it("detects auth and permissions", async () => {
    const status = await getAuthStatus(gh);
    expect(status.authenticated).toBe(true);
    expect(status.login).not.toBeNull();
    expect(Array.isArray(status.scopes)).toBe(true);
  }, 30_000);

  it("lists issues mapped onto the shared Issue contract", async () => {
    const records = await listIssues(gh, PROJECT, REPO);
    expect(records.length).toBeGreaterThan(0);
    const issueThree = records.find((r) => r.issue.number === 3);
    expect(issueThree).toBeDefined();
    expect(issueSchema.parse(issueThree?.issue).title).toContain("GitHub integration");
  }, 30_000);

  it("resolves blocked-by through the real GraphQL API", async () => {
    const res = await resolveBlockedBy(gh, REPO, 3);
    expect(res.issueNumber).toBe(3);
    expect(res.blocked).toBe(res.blockedBy.length > 0);
    expect(res.totalBlockers).toBeGreaterThanOrEqual(res.blockedBy.length);
  }, 30_000);

  it("fetches open issues with blockedBy in a single GraphQL query", async () => {
    const issues = await fetchIssuesWithBlockedBy(gh, PROJECT, REPO);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issueSchema.parse(issue).projectId).toBe(PROJECT);
    }
  }, 30_000);

  it("lists open PRs with CI status and review state", async () => {
    const prs = await listPullRequestsWithMeta(gh, PROJECT, REPO);
    for (const pr of prs) {
      expect(pullRequestSchema.parse(pr).state).toBe("open");
      expect(["pending", "running", "success", "failure", "unknown"]).toContain(pr.ciStatus);
      expect(["none", "pending", "approved", "changes_requested"]).toContain(pr.reviewState);
    }
  }, 60_000);
});
