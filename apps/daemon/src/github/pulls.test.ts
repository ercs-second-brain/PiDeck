import { describe, expect, it } from "vitest";
import { pullRequestSchema } from "@pideck/shared";

import { GhClient } from "./gh.js";
import { fetchReviewComments, getCiStatus, getReviewState, listOpenPullRequestsBatched, listPullRequests, listPullRequestsWithMeta, mapRestPull } from "./pulls.js";

const PROJECT = "proj";
const REPO = { owner: "ercs-second-brain", repo: "agentsKISS" };

const REST_PR = {
  number: 18,
  title: "Phase 0: Shared contracts",
  state: "open",
  merged_at: null,
  user: { login: "eric" },
  head: { ref: "ao/pideck-4/shared-contracts", sha: "abc123" },
  base: { ref: "main" },
  html_url: "https://github.com/ercs-second-brain/agentsKISS/pull/18",
  updated_at: "2026-09-06T12:00:00Z",
};

describe("mapRestPull", () => {
  it("maps an open PR onto the shared PullRequest contract", () => {
    const rec = mapRestPull(PROJECT, REST_PR);
    const pr = pullRequestSchema.parse(rec.pullRequest);
    expect(pr).toEqual({
      projectId: PROJECT,
      number: 18,
      title: "Phase 0: Shared contracts",
      state: "open",
      ciStatus: "unknown",
      reviewState: "none",
      headBranch: "ao/pideck-4/shared-contracts",
      baseBranch: "main",
      author: "eric",
      url: "https://github.com/ercs-second-brain/agentsKISS/pull/18",
      updatedAt: "2026-09-06T12:00:00Z",
    });
    expect(rec.headSha).toBe("abc123");
  });

  it("maps merged and closed states", () => {
    expect(mapRestPull(PROJECT, { ...REST_PR, state: "closed", merged_at: "2026-09-06T13:00:00Z" }).pullRequest.state).toBe("merged");
    expect(mapRestPull(PROJECT, { ...REST_PR, state: "closed", merged_at: null }).pullRequest.state).toBe("closed");
  });
});

describe("listPullRequests", () => {
  it("fetches and maps PRs", async () => {
    const gh = new GhClient(async (args) => {
      expect(args[1]).toContain("/repos/ercs-second-brain/agentsKISS/pulls?state=all");
      return { stdout: JSON.stringify([REST_PR]), stderr: "" };
    });
    const recs = await listPullRequests(gh, PROJECT, REPO);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.pullRequest.number).toBe(18);
  });
});

describe("getCiStatus", () => {
  function checkRuns(runs: Array<{ status: string; conclusion: string | null }>) {
    return async (args: string[]) => {
      if (args[1]?.includes("/check-runs")) {
        return { stdout: JSON.stringify({ total_count: runs.length, check_runs: runs }), stderr: "" };
      }
      if (args[1]?.includes("/status")) {
        return { stdout: JSON.stringify({ state: "success", total_count: 3 }), stderr: "" };
      }
      throw new Error(`unexpected args: ${JSON.stringify(args)}`);
    };
  }

  it("success when all completed runs succeeded (skipped/neutral are ok)", async () => {
    const gh = new GhClient(checkRuns([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }]));
    await expect(getCiStatus(gh, REPO, "abc123")).resolves.toBe("success");
  });

  it("failure as soon as one completed run failed", async () => {
    const gh = new GhClient(checkRuns([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "timed_out" }]));
    await expect(getCiStatus(gh, REPO, "abc123")).resolves.toBe("failure");
  });

  it("running / pending map from in_progress / queued", async () => {
    await expect(getCiStatus(new GhClient(checkRuns([{ status: "in_progress", conclusion: null }])), REPO, "s")).resolves.toBe("running");
    await expect(getCiStatus(new GhClient(checkRuns([{ status: "queued", conclusion: null }])), REPO, "s")).resolves.toBe("pending");
  });

  it("falls back to the legacy combined status when there are no check runs", async () => {
    const gh = new GhClient(async (args) => {
      const path = args[1] ?? "";
      if (path.includes("/check-runs")) return { stdout: JSON.stringify({ total_count: 0, check_runs: [] }), stderr: "" };
      if (path.includes("/status")) {
        expect(path).toContain("/commits/abc123/status");
        return { stdout: JSON.stringify({ state: "pending", total_count: 2 }), stderr: "" };
      }
      throw new Error(`unexpected args: ${JSON.stringify(args)}`);
    });
    await expect(getCiStatus(gh, REPO, "abc123")).resolves.toBe("pending");
  });

  it("returns unknown when there are no check runs and no statuses", async () => {
    const gh = new GhClient(async (args) => {
      if (args[1]?.includes("/check-runs")) return { stdout: JSON.stringify({ total_count: 0, check_runs: [] }), stderr: "" };
      return { stdout: JSON.stringify({ state: "success", total_count: 0 }), stderr: "" };
    });
    await expect(getCiStatus(gh, REPO, "abc123")).resolves.toBe("unknown");
  });
});

describe("getReviewState", () => {
  function reviews(list: Array<{ user: string; state: string }>) {
    return async (args: string[]) => {
      expect(args[1]).toBe("/repos/ercs-second-brain/agentsKISS/pulls/18/reviews");
      return {
        stdout: JSON.stringify(list.map((r) => ({ user: { login: r.user }, state: r.state, submitted_at: "2026-09-06T12:00:00Z" }))),
        stderr: "",
      };
    };
  }

  it("changes_requested wins over approvals", async () => {
    const gh = new GhClient(reviews([{ user: "a", state: "APPROVED" }, { user: "b", state: "CHANGES_REQUESTED" }]));
    await expect(getReviewState(gh, REPO, 18)).resolves.toBe("changes_requested");
  });

  it("uses the latest review per user (approval then dismissal)", async () => {
    const gh = new GhClient(reviews([{ user: "a", state: "APPROVED" }, { user: "a", state: "DISMISSED" }]));
    await expect(getReviewState(gh, REPO, 18)).resolves.toBe("none");
  });

  it("approved when the only decisive review is an approval", async () => {
    const gh = new GhClient(reviews([{ user: "a", state: "COMMENTED" }, { user: "a", state: "APPROVED" }]));
    await expect(getReviewState(gh, REPO, 18)).resolves.toBe("approved");
  });

  it("none without reviews", async () => {
    const gh = new GhClient(reviews([]));
    await expect(getReviewState(gh, REPO, 18)).resolves.toBe("none");
  });
});

describe("fetchReviewComments", () => {
  it("maps review comments including reply threading", async () => {
    const gh = new GhClient(async (args) => {
      expect(args[1]).toContain("/pulls/18/comments");
      return {
        stdout: JSON.stringify([
          {
            id: 1,
            user: { login: "reviewer" },
            body: "Please fix this",
            path: "src/a.ts",
            line: 42,
            in_reply_to_id: null,
            html_url: "https://github.com/ercs-second-brain/agentsKISS/pull/18#discussion_r1",
            created_at: "2026-09-06T12:00:00Z",
            updated_at: "2026-09-06T12:00:00Z",
          },
          {
            id: 2,
            user: { login: "eric" },
            body: "Done",
            path: "src/a.ts",
            line: null,
            in_reply_to_id: 1,
            html_url: "https://github.com/ercs-second-brain/agentsKISS/pull/18#discussion_r2",
            created_at: "2026-09-06T12:01:00Z",
            updated_at: "2026-09-06T12:01:00Z",
          },
        ]),
        stderr: "",
      };
    });
    const comments = await fetchReviewComments(gh, REPO, 18);
    expect(comments).toEqual([
      {
        id: 1,
        author: "reviewer",
        body: "Please fix this",
        path: "src/a.ts",
        line: 42,
        inReplyToId: null,
        url: "https://github.com/ercs-second-brain/agentsKISS/pull/18#discussion_r1",
        createdAt: "2026-09-06T12:00:00Z",
        updatedAt: "2026-09-06T12:00:00Z",
      },
      {
        id: 2,
        author: "eric",
        body: "Done",
        path: "src/a.ts",
        line: null,
        inReplyToId: 1,
        url: "https://github.com/ercs-second-brain/agentsKISS/pull/18#discussion_r2",
        createdAt: "2026-09-06T12:01:00Z",
        updatedAt: "2026-09-06T12:01:00Z",
      },
    ]);
  });
});

describe("listPullRequestsWithMeta", () => {
  it("enriches open PRs with CI status and review state in parallel", async () => {
    const gh = new GhClient(async (args) => {
      const path = args[1] ?? "";
      if (path.includes("/pulls?state=open")) return { stdout: JSON.stringify([REST_PR]), stderr: "" };
      if (path.includes("/check-runs")) return { stdout: JSON.stringify({ total_count: 1, check_runs: [{ status: "completed", conclusion: "failure" }] }), stderr: "" };
      if (path.includes("/reviews")) {
        return { stdout: JSON.stringify([{ user: { login: "a" }, state: "CHANGES_REQUESTED", submitted_at: "2026-09-06T12:00:00Z" }]), stderr: "" };
      }
      throw new Error(`unexpected args: ${JSON.stringify(args)}`);
    });
    const prs = await listPullRequestsWithMeta(gh, PROJECT, REPO);
    expect(prs).toHaveLength(1);
    expect(prs[0]?.ciStatus).toBe("failure");
    expect(prs[0]?.reviewState).toBe("changes_requested");
  });
});

describe("listOpenPullRequestsBatched", () => {
  /** GraphQL pullRequest node for the batched listing (issue #40). */
  function gqlNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      number: 18,
      title: "Phase 0: Shared contracts",
      url: "https://github.com/ercs-second-brain/agentsKISS/pull/18",
      updatedAt: "2026-09-06T12:00:00Z",
      author: { login: "eric" },
      headRefName: "ao/pideck-4/shared-contracts",
      baseRefName: "main",
      headRefOid: "abc123",
      reviewDecision: "CHANGES_REQUESTED",
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
      ...overrides,
    };
  }

  function batchedGh(node: Record<string, unknown>, seen: string[][]): GhClient {
    return new GhClient(async (args) => {
      seen.push(args);
      return { stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: [node] } } } }), stderr: "" };
    });
  }

  it("resolves CI status and review decision in a single GraphQL call", async () => {
    const seen: string[][] = [];
    const prs = await listOpenPullRequestsBatched(batchedGh(gqlNode(), seen), PROJECT, REPO);
    // One call total — no per-PR enrichment (issue #40).
    expect(seen).toHaveLength(1);
    expect(seen[0]?.slice(0, 3)).toEqual(["api", "graphql", "-f"]);
    expect(seen[0]?.some((a) => a === "owner=ercs-second-brain")).toBe(true);
    const pr = pullRequestSchema.parse(prs[0]);
    expect(pr.ciStatus).toBe("failure");
    expect(pr.reviewState).toBe("changes_requested");
    expect(pr.state).toBe("open");
    expect(pr.headBranch).toBe("ao/pideck-4/shared-contracts");
  });

  it("passes the recency limit via -F and maps missing rollup/review to unknown/none", async () => {
    const seen: string[][] = [];
    const node = gqlNode({ reviewDecision: null, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } });
    const prs = await listOpenPullRequestsBatched(batchedGh(node, seen), PROJECT, REPO, { first: 25 });
    expect(seen[0]).toContain("-F");
    expect(seen[0]).toContain("first=25");
    expect(prs[0]?.ciStatus).toBe("unknown");
    expect(prs[0]?.reviewState).toBe("none");
  });

  it("maps the rollup states onto the shared CiStatus enum", async () => {
    const cases: Array<[string | null, string]> = [
      ["SUCCESS", "success"],
      ["FAILURE", "failure"],
      ["ERROR", "failure"],
      ["PENDING", "pending"],
      ["EXPECTED", "pending"],
    ];
    for (const [state, expected] of cases) {
      const node = gqlNode({ commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } });
      const prs = await listOpenPullRequestsBatched(batchedGh(node, []), PROJECT, REPO);
      expect(prs[0]?.ciStatus).toBe(expected);
    }
  });

  it("tolerates a deleted author and an empty commits list", async () => {
    const node = gqlNode({ author: null, commits: { nodes: [] } });
    const prs = await listOpenPullRequestsBatched(batchedGh(node, []), PROJECT, REPO);
    expect(prs[0]?.author).toBe("unknown");
    expect(prs[0]?.ciStatus).toBe("unknown");
  });
});
