import { describe, expect, it } from "vitest";
import { GhClient, type GhExec, type GhExecResult } from "./client.js";
import { GhError } from "./error.js";

type Call = { args: string[]; env: NodeJS.ProcessEnv };

const ISSUE_LIST_JSON = JSON.stringify([
  {
    number: 517,
    title: "Phase 1: GitHub client over gh",
    url: "https://github.com/o/r/issues/517",
    assignees: [{ login: "worker-bot" }],
    labels: [{ name: "phase-1" }],
  },
  {
    number: 520,
    title: "Blocked thing",
    url: "https://github.com/o/r/issues/520",
    assignees: [],
    labels: [],
  },
]);

const BLOCKED_BY_JSON = JSON.stringify([
  { number: 514, state: "closed" },
  { number: 516, state: "open" },
]);

const ISSUE_COMMENTS_JSON = JSON.stringify([
  { id: 10, user: { login: "orch" }, body: "first", created_at: "2026-01-01T00:00:00Z" },
  { id: 12, user: { login: "worker-bot" }, body: "second", created_at: "2026-01-01T00:01:00Z" },
  { id: 11, user: null, body: "out of order", created_at: "2026-01-01T00:02:00Z" },
]);

const PR_LIST_JSON = JSON.stringify([
  {
    number: 537,
    headRefName: "pideck/issue-517",
    headRefOid: "abc123",
    mergeable: "MERGEABLE",
    reviewDecision: "",
    statusCheckRollup: [
      { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "CI" },
      { name: "lint", status: "COMPLETED", conclusion: "FAILURE", workflowName: "CI" },
      { name: "build", status: "IN_PROGRESS", conclusion: null },
    ],
  },
  {
    number: 540,
    headRefName: "pideck/issue-520",
    headRefOid: "def456",
    mergeable: "CONFLICTING",
    reviewDecision: "CHANGES_REQUESTED",
    statusCheckRollup: [],
  },
]);

const REVIEWS_JSON = JSON.stringify([
  {
    id: 9001,
    user: { login: "reviewer-bot" },
    state: "CHANGES_REQUESTED",
    submitted_at: "2026-01-02T00:00:00Z",
    body: "Please fix",
  },
]);

const PR_COMMENTS_JSON = JSON.stringify([
  { id: 20, user: { login: "worker-bot" }, body: "pushed", created_at: "2026-01-02T01:00:00Z" },
  { id: 21, user: { login: "reviewer-bot" }, body: "still broken", created_at: "2026-01-02T02:00:00Z" },
]);

const ok = (stdout: string): GhExecResult => ({ stdout, stderr: "", exitCode: 0 });

function fakeExec(responses: (call: Call, index: number) => GhExecResult): { client: GhClient; calls: Call[] } {
  const calls: Call[] = [];
  const exec: GhExec = async (args, env) => {
    const result = responses({ args, env }, calls.length);
    calls.push({ args, env });
    return result;
  };
  return { client: new GhClient({ repo: "o/r", exec }), calls };
}

describe("GhClient", () => {
  it("openIssues maps assignees and labels", async () => {
    const { client, calls } = fakeExec(() => ok(ISSUE_LIST_JSON));
    const issues = await client.openIssues();
    expect(issues).toEqual([
      {
        number: 517,
        title: "Phase 1: GitHub client over gh",
        url: "https://github.com/o/r/issues/517",
        assignees: ["worker-bot"],
        labels: ["phase-1"],
      },
      {
        number: 520,
        title: "Blocked thing",
        url: "https://github.com/o/r/issues/520",
        assignees: [],
        labels: [],
      },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("blockedBy fetches blocker number and state for one issue", async () => {
    const { client, calls } = fakeExec(() => ok(BLOCKED_BY_JSON));
    expect(await client.blockedBy(517)).toEqual([
      { number: 514, state: "closed" },
      { number: 516, state: "open" },
    ]);
    expect(calls[0]?.args).toEqual(["api", "repos/o/r/issues/517/dependencies/blocked_by"]);
  });

  it("issueComments returns comments after the watermark, ascending by id", async () => {
    const { client } = fakeExec(() => ok(ISSUE_COMMENTS_JSON));
    const since = await client.issueComments(517, 10);
    expect(since.map((c) => c.id)).toEqual([11, 12]);
    const all = await client.issueComments(517);
    expect(all.map((c) => c.id)).toEqual([10, 11, 12]);
    expect(all[1]).toEqual({ id: 11, author: null, body: "out of order", createdAt: "2026-01-01T00:02:00Z" });
  });

  it("openPrs maps head, mergeable, reviewDecision and CI rollup", async () => {
    const { client } = fakeExec(() => ok(PR_LIST_JSON));
    const prs = await client.openPrs();
    expect(prs[0]).toEqual({
      number: 537,
      headBranch: "pideck/issue-517",
      headSha: "abc123",
      mergeable: "MERGEABLE",
      reviewDecision: null,
      ciStatus: "failed",
      failingChecks: ["lint"],
    });
    expect(prs[1]).toEqual({
      number: 540,
      headBranch: "pideck/issue-520",
      headSha: "def456",
      mergeable: "CONFLICTING",
      reviewDecision: "CHANGES_REQUESTED",
      ciStatus: "ok",
      failingChecks: [],
    });
  });

  it("prReviews maps id, author, state, submittedAt and body", async () => {
    const { client } = fakeExec(() => ok(REVIEWS_JSON));
    const reviews = await client.prReviews(537);
    expect(reviews).toEqual([
      {
        id: 9001,
        author: "reviewer-bot",
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-01-02T00:00:00Z",
        body: "Please fix",
      },
    ]);
  });

  it("prReviewComments filters since an id", async () => {
    const { client } = fakeExec(() => ok(PR_COMMENTS_JSON));
    const since = await client.prReviewComments(537, 20);
    expect(since.map((c) => c.id)).toEqual([21]);
  });

  it("prBody returns the body text", async () => {
    const { client } = fakeExec(() => ok(JSON.stringify({ body: "Closes #517" })));
    expect(await client.prBody(537)).toBe("Closes #517");
  });

  it("prBody treats a null body as empty", async () => {
    const { client } = fakeExec(() => ok(JSON.stringify({ body: null })));
    expect(await client.prBody(537)).toBe("");
  });

  it("sets GH_TOKEN only when a token is provided", async () => {
    const plain = fakeExec(() => ok("[]"));
    await plain.client.issueComments(1);
    expect(plain.calls[0]?.env.GH_TOKEN).toBeUndefined();

    const calls: Call[] = [];
    const exec: GhExec = async (args, env) => {
      calls.push({ args, env });
      return ok("[]");
    };
    const review = new GhClient({ repo: "o/r", token: "tok", exec });
    await review.issueComments(1);
    expect(calls[0]?.env.GH_TOKEN).toBe("tok");
  });

  it("throws GhError with command and stderr on nonzero exit", async () => {
    const { client } = fakeExec(() => ({ stdout: "", stderr: "gh: not found\n", exitCode: 1 }));
    const err = await client.openIssues().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhError);
    const ghErr = err as GhError;
    expect(ghErr.command).toContain("issue list --repo o/r");
    expect(ghErr.stderr).toBe("gh: not found\n");
    expect(ghErr.exitCode).toBe(1);
  });

  it("throws GhError when stdout is not JSON", async () => {
    const { client } = fakeExec(() => ok("nope"));
    const err = await client.issueComments(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhError);
    expect((err as GhError).exitCode).toBeNull();
  });

  it("throws GhError when the response fails validation", async () => {
    const { client } = fakeExec(() => ok(JSON.stringify([{ nope: true }])));
    const err = await client.issueComments(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhError);
    expect((err as GhError).stderr).toContain("id");
  });

  it("assign and unassign shell out to gh issue edit", async () => {
    const { client, calls } = fakeExec(() => ok(""));
    await client.assignIssue(517, "worker-bot");
    await client.unassignIssue(517, "worker-bot");
    expect(calls[0]?.args).toEqual(["issue", "edit", "517", "--repo", "o/r", "--add-assignee", "worker-bot"]);
    expect(calls[1]?.args).toEqual(["issue", "edit", "517", "--repo", "o/r", "--remove-assignee", "worker-bot"]);
  });

  it("addIssueComment posts via the API and returns the comment id", async () => {
    const { client, calls } = fakeExec(() => ok(JSON.stringify({ id: 4242 })));
    const id = await client.addIssueComment(517, "blocked on X");
    expect(id).toBe(4242);
    expect(calls[0]?.args).toEqual([
      "api", "--method", "POST", "repos/o/r/issues/517/comments", "-f", "body=blocked on X",
    ]);
  });

  it("addPrComment posts a plain comment via the issue endpoint and returns its id", async () => {
    const { client, calls } = fakeExec(() => ok(JSON.stringify({ id: 77 })));
    const id = await client.addPrComment(537, "pushed fixes");
    expect(id).toBe(77);
    expect(calls[0]?.args).toEqual([
      "api", "--method", "POST", "repos/o/r/issues/537/comments", "-f", "body=pushed fixes",
    ]);
  });

  it("mergePr squashes and deletes the branch", async () => {
    const { client, calls } = fakeExec(() => ok(""));
    await client.mergePr(537);
    expect(calls[0]?.args).toEqual(["pr", "merge", "537", "--repo", "o/r", "--squash", "--delete-branch"]);
  });

  it("requestReview adds a reviewer", async () => {
    const { client, calls } = fakeExec(() => ok(""));
    await client.requestReview(537, "reviewer-bot");
    expect(calls[0]?.args).toEqual(["pr", "edit", "537", "--repo", "o/r", "--add-reviewer", "reviewer-bot"]);
  });

  it("authStatus reports the login on success", async () => {
    const { client, calls } = fakeExec(() => ({
      stdout: "github.com\n  ✓ Logged in to github.com account some-user (/hosts.yml)\n",
      stderr: "",
      exitCode: 0,
    }));
    const probe = await client.authStatus();
    expect(probe).toEqual({ ok: true, detail: "logged in as some-user" });
    expect(calls[0]?.args).toEqual(["auth", "status"]);
  });

  it("authStatus fails with stderr detail when not logged in", async () => {
    const { client } = fakeExec(() => ({ stdout: "", stderr: "not logged into any hosts\n", exitCode: 4 }));
    const probe = await client.authStatus();
    expect(probe).toEqual({ ok: false, detail: "not logged into any hosts" });
  });
});
