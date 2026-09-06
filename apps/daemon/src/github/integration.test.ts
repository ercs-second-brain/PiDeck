/**
 * Integration-style tests for the github library: the combined flows the
 * daemon actually runs (auth probe → issue list → blocked-by resolution →
 * issues-with-blockers → open PRs with CI/review meta), exercised end-to-end
 * through a fake `gh` runner that dispatches on the real gh argv shapes.
 *
 * Hermetic by design: no network access, no live GitHub state, and no
 * assertions on mutable live entities (issue numbers/titles/states of real
 * issues). Runs identically on a clean clone with or without network/gh auth.
 *
 * A read-only smoke suite against the real GitHub API exists below, but it is
 * opt-in: it only runs when `AGENTSKISS_LIVE_GH_TESTS=1` is set AND a gh token
 * is available, and it never asserts on specific live entities — only that the
 * calls succeed and map onto the shared contract schemas.
 */

import { describe, expect, it } from "vitest";
import { issueSchema, pullRequestSchema, type Issue, type PullRequest } from "@agentskiss/shared";

import { getAuthStatus, hasGhToken } from "./auth.js";
import { defaultGhRunner, GhClient, type GhRunner, type RepoRef } from "./gh.js";
import { fetchIssuesWithBlockedBy, listIssues, resolveBlockedBy } from "./issues.js";
import { listPullRequestsWithMeta } from "./pulls.js";

const PROJECT = "integration-test";
const REPO: RepoRef = { owner: "fixture-owner", repo: "fixture-repo" };

// ---------------------------------------------------------------------------
// Canned fixtures — shapes copied from the real API (see unit tests' docblocks)
// ---------------------------------------------------------------------------

const REST_ISSUE = {
  number: 101,
  title: "Fixture issue: wired to the project board",
  state: "open",
  user: { login: "fixture-alice" },
  assignee: null,
  assignees: [],
  html_url: "https://github.com/fixture-owner/fixture-repo/issues/101",
  updated_at: "2026-09-06T12:00:00Z",
};

const REST_PULL = {
  number: 201,
  title: "Fixture PR: adds a feature",
  state: "open",
  merged_at: null,
  user: { login: "fixture-bob" },
  head: { ref: "fixture/branch", sha: "abc123" },
  base: { ref: "main" },
  html_url: "https://github.com/fixture-owner/fixture-repo/pull/201",
  updated_at: "2026-09-06T13:00:00Z",
};

// Distinctive substrings of the two GraphQL queries in issues.ts (the inner
// blockedBy connection uses a literal `first: 100` in both, so it cannot
// distinguish them).
const ISSUES_QUERY_MARKER = "issues(first: $first";
const BLOCKEDBY_QUERY_MARKER = "issue(number: $number";

/** GraphQL issues-list node for `fetchIssuesWithBlockedBy`. */
function graphqlIssueNode(number: number, blockers: Array<{ number: number; state: "OPEN" | "CLOSED" }>) {
  return {
    number,
    title: `Fixture issue ${number}`,
    url: `https://github.com/fixture-owner/fixture-repo/issues/${number}`,
    updatedAt: "2026-09-06T12:00:00Z",
    assignees: { nodes: [{ login: "fixture-alice" }] },
    blockedBy: {
      nodes: blockers.map((b) => ({
        number: b.number,
        state: b.state,
        repository: { nameWithOwner: "fixture-owner/fixture-repo" },
      })),
    },
  };
}

/** GraphQL single-issue blockedBy node for `resolveBlockedBy`. */
function graphqlBlockedByNode(number: number, blockers: Array<{ number: number; state: "OPEN" | "CLOSED" }>) {
  return {
    number,
    blockedBy: {
      totalCount: blockers.length,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: blockers.map((b) => ({
        number: b.number,
        state: b.state,
        repository: { nameWithOwner: "fixture-owner/fixture-repo" },
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Fake gh runner dispatching on the real argv shapes produced by GhClient
// ---------------------------------------------------------------------------

/** GraphQL response wrapper as gh prints it. */
function gql(data: unknown): string {
  return JSON.stringify({ data });
}

/**
 * Builds a GhRunner that serves the canned fixtures above for every call the
 * integration flows make. Dispatches on argv exactly like the real `gh`
 * binary would see it; unknown calls fail loudly.
 */
function fixtureGhRunner(): GhRunner {
  return async (args) => {
    if (args[0] !== "api") throw new Error(`fixtureGhRunner: expected "api", got: ${JSON.stringify(args)}`);

    // gh api -i /user — auth probe (headers + login).
    if (args[1] === "-i" && args[2] === "/user") {
      return {
        stdout: [
          "HTTP/2.0 200 OK",
          "x-oauth-scopes: repo, workflow",
          "",
          JSON.stringify({ login: "fixture-user" }),
        ].join("\n"),
        stderr: "",
      };
    }

    // gh api graphql — dispatch on the query shape.
    if (args[1] === "graphql") {
      const queryArg = args.find((a, i) => args[i - 1] === "-f" && a.startsWith("query="));
      if (queryArg === undefined) throw new Error(`fixtureGhRunner: graphql call without query: ${JSON.stringify(args)}`);
      if (queryArg.includes(ISSUES_QUERY_MARKER)) {
        return { stdout: gql({ repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [graphqlIssueNode(102, [{ number: 101, state: "OPEN" }]), graphqlIssueNode(103, [{ number: 102, state: "CLOSED" }])] } } }), stderr: "" };
      }
      if (queryArg.includes(BLOCKEDBY_QUERY_MARKER)) {
        const numberArg = args.find((a, i) => args[i - 1] === "-F" && a.startsWith("number="));
        if (numberArg === undefined) throw new Error(`fixtureGhRunner: blockedBy call without number: ${JSON.stringify(args)}`);
        const number = Number(numberArg.slice("number=".length));
        if (number === 101) {
          return { stdout: gql({ repository: { issue: graphqlBlockedByNode(101, [{ number: 100, state: "OPEN" }, { number: 99, state: "CLOSED" }]) } }), stderr: "" };
        }
        return { stdout: gql({ repository: { issue: graphqlBlockedByNode(number, []) } }), stderr: "" };
      }
      throw new Error(`fixtureGhRunner: unknown graphql query: ${queryArg}`);
    }

    // REST endpoints — dispatch on path.
    const path = args[1] ?? "";
    if (path.startsWith("/repos/fixture-owner/fixture-repo/issues?")) {
      return { stdout: JSON.stringify([REST_ISSUE]), stderr: "" };
    }
    if (path.startsWith("/repos/fixture-owner/fixture-repo/pulls?")) {
      return { stdout: JSON.stringify([REST_PULL]), stderr: "" };
    }
    if (path === "/repos/fixture-owner/fixture-repo/commits/abc123/check-runs") {
      return {
        stdout: JSON.stringify({ total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] }),
        stderr: "",
      };
    }
    if (path === "/repos/fixture-owner/fixture-repo/pulls/201/reviews") {
      return {
        stdout: JSON.stringify([{ user: { login: "fixture-alice" }, state: "APPROVED", submitted_at: "2026-09-06T14:00:00Z" }]),
        stderr: "",
      };
    }
    throw new Error(`fixtureGhRunner: no route for args: ${JSON.stringify(args)}`);
  };
}

describe("integration: github flows end-to-end over a fake gh runner (hermetic)", () => {
  const gh = new GhClient(fixtureGhRunner());

  it("detects auth, login, and scopes from `gh api -i /user`", async () => {
    const status = await getAuthStatus(gh);
    expect(status.authenticated).toBe(true);
    expect(status.login).toBe("fixture-user");
    expect(status.scopes).toEqual(["repo", "workflow"]);
  });

  it("lists issues mapped onto the shared Issue contract", async () => {
    const records = await listIssues(gh, PROJECT, REPO);
    expect(records).toHaveLength(1);
    const issue = issueSchema.parse(records[0]?.issue);
    expect(issue.projectId).toBe(PROJECT);
    expect(issue.number).toBe(101);
    expect(issue.state).toBe("open");
    expect(records[0]?.author).toBe("fixture-alice");
  });

  it("resolves blocked-by through the GraphQL flow", async () => {
    const res = await resolveBlockedBy(gh, REPO, 101);
    expect(res.issueNumber).toBe(101);
    expect(res.blockedBy).toEqual([100]);
    expect(res.blocked).toBe(true);
    expect(res.totalBlockers).toBe(2);
  });

  it("fetches open issues with blockedBy in a single GraphQL query", async () => {
    const issues: Issue[] = await fetchIssuesWithBlockedBy(gh, PROJECT, REPO);
    expect(issues.map((i) => i.number)).toEqual([102, 103]);
    for (const issue of issues) {
      expect(issueSchema.parse(issue).projectId).toBe(PROJECT);
    }
    // Only open same-repo blockers count; closed ones are filtered out.
    expect(issues[0]?.blockedBy).toEqual([101]);
    expect(issues[1]?.blockedBy).toEqual([]);
  });

  it("lists open PRs with CI status and review state", async () => {
    const prs: PullRequest[] = await listPullRequestsWithMeta(gh, PROJECT, REPO);
    expect(prs).toHaveLength(1);
    const pr = pullRequestSchema.parse(prs[0]);
    expect(pr.state).toBe("open");
    expect(pr.ciStatus).toBe("success");
    expect(pr.reviewState).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// Opt-in live smoke suite — read-only, no assertions on live entities
// ---------------------------------------------------------------------------

const liveEnabled = process.env["AGENTSKISS_LIVE_GH_TESTS"] === "1";
// Only probe for a token when the live suite is actually enabled, so the
// hermetic suite never touches the gh binary at all.
const hasToken = liveEnabled ? await hasGhToken(defaultGhRunner) : false;
const LIVE_REPO = { owner: "ercs-second-brain", repo: "agentsKISS" };

const dl = describe.skipIf(!liveEnabled || !hasToken);

dl("integration: read-only live GitHub smoke (opt-in via AGENTSKISS_LIVE_GH_TESTS=1)", () => {
  const gh = new GhClient(defaultGhRunner);

  it("probes auth", async () => {
    const status = await getAuthStatus(gh);
    expect(status.authenticated).toBe(true);
  }, 30_000);

  it("lists issues that map onto the shared contract (no entity assertions)", async () => {
    const records = await listIssues(gh, PROJECT, LIVE_REPO);
    for (const record of records) {
      expect(issueSchema.parse(record.issue).projectId).toBe(PROJECT);
    }
  }, 30_000);

  it("fetches open issues with blockedBy that map onto the shared contract", async () => {
    const issues = await fetchIssuesWithBlockedBy(gh, PROJECT, LIVE_REPO);
    for (const issue of issues) {
      expect(issueSchema.parse(issue).projectId).toBe(PROJECT);
    }
  }, 30_000);

  it("lists open PRs whose meta maps onto the shared contract", async () => {
    const prs = await listPullRequestsWithMeta(gh, PROJECT, LIVE_REPO);
    for (const pr of prs) {
      expect(pullRequestSchema.parse(pr).state).toBe("open");
      expect(["pending", "running", "success", "failure", "unknown"]).toContain(pr.ciStatus);
      expect(["none", "pending", "approved", "changes_requested"]).toContain(pr.reviewState);
    }
  }, 60_000);
});
