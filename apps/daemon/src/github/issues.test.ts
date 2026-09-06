import { describe, expect, it } from "vitest";
import { issueSchema, type Issue } from "@agentskiss/shared";

import { GhClient } from "./gh.js";
import { fetchIssuesWithBlockedBy, listIssues, mapRestIssue, resolveBlockedBy } from "./issues.js";

const PROJECT = "proj";
const REPO = { owner: "ercs-second-brain", repo: "agentsKISS" };

const REST_ISSUE = {
  number: 3,
  title: "Phase 1: GitHub integration layer",
  state: "open",
  user: { login: "eric" },
  assignee: null,
  assignees: [],
  html_url: "https://github.com/ercs-second-brain/agentsKISS/issues/3",
  updated_at: "2026-09-06T12:00:00Z",
};

describe("mapRestIssue", () => {
  it("maps a REST issue onto the shared Issue contract", () => {
    const record = mapRestIssue(PROJECT, REST_ISSUE);
    expect(record).not.toBeNull();
    const issue = issueSchema.parse(record?.issue);
    expect(issue).toEqual({
      projectId: PROJECT,
      number: 3,
      title: "Phase 1: GitHub integration layer",
      state: "open",
      blockedBy: [],
      assignee: null,
      url: "https://github.com/ercs-second-brain/agentsKISS/issues/3",
      updatedAt: "2026-09-06T12:00:00Z",
    });
    expect(record?.author).toBe("eric");
    expect(record?.assignees).toEqual([]);
  });

  it("takes the primary assignee from assignee/assignees", () => {
    const record = mapRestIssue(PROJECT, { ...REST_ISSUE, assignee: { login: "a" }, assignees: [{ login: "a" }, { login: "b" }] });
    expect(record?.issue.assignee).toBe("a");
    expect(record?.assignees).toEqual(["a", "b"]);
  });

  it("skips PR entries and invalid payloads", () => {
    expect(mapRestIssue(PROJECT, { ...REST_ISSUE, pull_request: { url: "https://x" } })).toBeNull();
    expect(mapRestIssue(PROJECT, { number: "nope" })).toBeNull();
  });
});

describe("listIssues", () => {
  it("fetches open issues and filters out PRs", async () => {
    const gh = new GhClient(async (args) => {
      expect(args[1]).toContain("/repos/ercs-second-brain/agentsKISS/issues?state=open&sort=updated&direction=desc");
      return { stdout: JSON.stringify([REST_ISSUE, { ...REST_ISSUE, number: 4, pull_request: {} }]), stderr: "" };
    });
    const records = await listIssues(gh, PROJECT, REPO);
    expect(records).toHaveLength(1);
    expect(records[0]?.issue.number).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// blocked-by (shape verified against the live API — see PR description)
// ---------------------------------------------------------------------------

function graphqlNode(blockers: Array<{ number: number; state: "OPEN" | "CLOSED"; repo?: string }>) {
  return {
    number: 2,
    blockedBy: {
      totalCount: blockers.length,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: blockers.map((b) => ({
        number: b.number,
        state: b.state,
        repository: { nameWithOwner: b.repo ?? "ercs-second-brain/agentsKISS" },
      })),
    },
  };
}

describe("resolveBlockedBy", () => {
  it("reports blocked=true with open same-repo blockers, ignoring closed and cross-repo ones", async () => {
    const gh = new GhClient(async (args) => {
      expect(args[0]).toBe("api");
      expect(args[1]).toBe("graphql");
      expect(args).toContain("-F");
      expect(args).toContain("number=2");
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              issue: graphqlNode([
                { number: 1, state: "OPEN" },
                { number: 5, state: "CLOSED" },
                { number: 9, state: "OPEN", repo: "other/repo" },
              ]),
            },
          },
        }),
        stderr: "",
      };
    });
    const res = await resolveBlockedBy(gh, REPO, 2);
    expect(res).toEqual({ issueNumber: 2, blockedBy: [1], blocked: true, totalBlockers: 3 });
  });

  it("reports blocked=false when every blocker is closed", async () => {
    const gh = new GhClient(async () => ({
      stdout: JSON.stringify({ data: { repository: { issue: graphqlNode([{ number: 5, state: "CLOSED" }]) } } }),
      stderr: "",
    }));
    const res = await resolveBlockedBy(gh, REPO, 2);
    expect(res.blocked).toBe(false);
    expect(res.blockedBy).toEqual([]);
    expect(res.totalBlockers).toBe(1);
  });

  it("paginates via endCursor", async () => {
    const pages = [
      {
        number: 2,
        blockedBy: {
          totalCount: 2,
          pageInfo: { hasNextPage: true, endCursor: "MQ" },
          nodes: [{ number: 1, state: "OPEN", repository: { nameWithOwner: "ercs-second-brain/agentsKISS" } }],
        },
      },
      {
        number: 2,
        blockedBy: {
          totalCount: 2,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ number: 4, state: "OPEN", repository: { nameWithOwner: "ercs-second-brain/agentsKISS" } }],
        },
      },
    ];
    const queries: string[] = [];
    const gh = new GhClient(async (args) => {
      const query = args.find((a) => a.startsWith("query=")) ?? "";
      queries.push(query);
      // Second call passes -f after=MQ.
      const body = args.some((a) => a === "after=MQ") ? pages[1] : pages[0];
      return { stdout: JSON.stringify({ data: { repository: { issue: body } } }), stderr: "" };
    });
    const res = await resolveBlockedBy(gh, REPO, 2);
    expect(res.blockedBy).toEqual([1, 4]);
    expect(res.blocked).toBe(true);
    expect(queries).toHaveLength(2);
    expect(queries.every((q) => q === queries[0])).toBe(true);
  });

  it("throws for a missing issue", async () => {
    const gh = new GhClient(async () => ({
      stdout: JSON.stringify({ data: { repository: { issue: null } } }),
      stderr: "",
    }));
    await expect(resolveBlockedBy(gh, REPO, 999)).rejects.toThrow(/not found/);
  });
});

describe("fetchIssuesWithBlockedBy", () => {
  it("maps open issues with their open same-repo blockers in one query", async () => {
    const gh = new GhClient(async () => ({
      stdout: JSON.stringify({
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 2,
                  title: "Dependent issue",
                  url: "https://github.com/ercs-second-brain/agentsKISS/issues/2",
                  updatedAt: "2026-09-06T12:00:00Z",
                  assignees: { nodes: [{ login: "eric" }] },
                  blockedBy: {
                    nodes: [
                      { number: 1, state: "OPEN", repository: { nameWithOwner: "ercs-second-brain/agentsKISS" } },
                      { number: 5, state: "CLOSED", repository: { nameWithOwner: "ercs-second-brain/agentsKISS" } },
                    ],
                  },
                },
              ],
            },
          },
        },
      }),
      stderr: "",
    }));
    const issues: Issue[] = await fetchIssuesWithBlockedBy(gh, PROJECT, REPO);
    expect(issues).toEqual([
      {
        projectId: PROJECT,
        number: 2,
        title: "Dependent issue",
        state: "open",
        blockedBy: [1],
        assignee: "eric",
        url: "https://github.com/ercs-second-brain/agentsKISS/issues/2",
        updatedAt: "2026-09-06T12:00:00Z",
      },
    ]);
  });
});
