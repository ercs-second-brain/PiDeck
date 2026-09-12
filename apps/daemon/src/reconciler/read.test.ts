import { describe, expect, it } from "vitest";
import { ProbeSchema } from "@pideck/shared";
import { ciRollup, type GhPr } from "../github/schemas.js";
import { ProjectReader, parseIssueBranch, type GhRead } from "./read.js";

function fakeGh(overrides: Partial<GhRead> = {}): GhRead & { calls: string[] } {
  const calls: string[] = [];
  const base: GhRead = {
    openIssues: async () => {
      calls.push("openIssues");
      return [];
    },
    blockedBy: async (n) => {
      calls.push(`blockedBy:${n}`);
      return [];
    },
    issueComments: async (n) => {
      calls.push(`issueComments:${n}`);
      return [];
    },
    openPrs: async () => {
      calls.push("openPrs");
      return [];
    },
    prReviews: async (n) => {
      calls.push(`prReviews:${n}`);
      return [];
    },
    prReviewComments: async (n) => {
      calls.push(`prReviewComments:${n}`);
      return [];
    },
    authStatus: async () => {
      calls.push("authStatus");
      return ProbeSchema.parse({ ok: true, detail: "logged in as acme-worker" });
    },
  };
  return { ...base, ...overrides, calls };
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: "Add rate limiting",
    url: "https://github.com/acme/my-api/issues/1",
    assignees: ["acme-worker"],
    labels: [],
    ...overrides,
  };
}

/** A post-GhClient PR fact, mapped exactly like GhClient.openPrs does. */
function pr(overrides: Record<string, unknown> = {}): GhPr {
  const raw = {
    number: 11,
    headRefName: "pideck/issue-1",
    headRefOid: "sha-1",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    statusCheckRollup: [],
    ...overrides,
  };
  const rollup = ciRollup(raw.statusCheckRollup as Parameters<typeof ciRollup>[0]);
  return {
    number: raw.number,
    headBranch: raw.headRefName,
    headSha: raw.headRefOid,
    mergeable: raw.mergeable as GhPr["mergeable"],
    reviewDecision: (raw.reviewDecision as string | null) ?? null,
    ciStatus: rollup.ciStatus,
    failingChecks: rollup.failingChecks,
  };
}

describe("parseIssueBranch", () => {
  it("reads the issue number off the pideck branch", () => {
    expect(parseIssueBranch("pideck/issue-42")).toBe(42);
    expect(parseIssueBranch("pideck/issue-42-fix")).toBeNull();
    expect(parseIssueBranch("main")).toBeNull();
  });
});

describe("ProjectReader", () => {
  it("resolves the primary login from the gh auth probe", async () => {
    const gh = fakeGh();
    const reader = new ProjectReader(gh);
    const read = await reader.read();
    expect(read.primaryLogin).toBe("acme-worker");
    expect(gh.calls.filter((c) => c === "authStatus")).toHaveLength(1);
  });

  it("falls back to null when the probe fails, and treats any assignee as assigned", async () => {
    const gh = fakeGh({
      authStatus: async () => ProbeSchema.parse({ ok: false, detail: "not logged in" }),
      openIssues: async () => [issue({ assignees: ["someone"] })],
    });
    const read = await new ProjectReader(gh).read();
    expect(read.primaryLogin).toBeNull();
    expect(read.issues[0]!.openBlockers).toBe(0);
    expect(gh.calls).toContain("blockedBy:1");
  });

  it("fetches blockers and comments only for assigned issues", async () => {
    const gh = fakeGh({
      openIssues: async () => [
        issue({ number: 1 }),
        issue({ number: 2, assignees: [] }),
        issue({ number: 3, assignees: ["someone-else"] }),
      ],
    });
    const read = await new ProjectReader(gh).read();
    expect(gh.calls.filter((c) => c.startsWith("blockedBy"))).toEqual(["blockedBy:1"]);
    expect(gh.calls.filter((c) => c.startsWith("issueComments"))).toEqual(["issueComments:1"]);
    expect(read.issues).toHaveLength(3);
    expect(read.issues[1]!.comments).toEqual([]);
  });

  it("counts open blockers for assigned issues", async () => {
    const gh = fakeGh({
      openIssues: async () => [issue()],
      blockedBy: async () => [
        { number: 2, state: "closed" },
        { number: 3, state: "open" },
      ],
    });
    const read = await new ProjectReader(gh).read();
    expect(read.issues[0]!.openBlockers).toBe(1);
  });

  it("guards green against the empty-rollup race: the head must be seen twice", async () => {
    const gh = fakeGh({
      openPrs: async () => [pr()],
      prReviews: async () => [],
      prReviewComments: async () => [],
    });
    const reader = new ProjectReader(gh);

    const first = await reader.read();
    expect(first.prs[0]!.ciStatus).toBe("ok");
    expect(first.prs[0]!.green).toBe(false);

    const second = await reader.read();
    expect(second.prs[0]!.green).toBe(true);
  });

  it("a changed head is never green on first sight", async () => {
    let sha = "sha-1";
    const gh = fakeGh({
      openPrs: async () => [pr({ headRefOid: sha })],
    });
    const reader = new ProjectReader(gh);
    expect((await reader.read()).prs[0]!.green).toBe(false);
    expect((await reader.read()).prs[0]!.green).toBe(true);

    sha = "sha-2";
    const afterPush = await reader.read();
    expect(afterPush.prs[0]!.green).toBe(false);
    expect(afterPush.prs[0]!.ciStatus).toBe("ok");
  });

  it("failing checks are never green regardless of head stability", async () => {
    const gh = fakeGh({
      openPrs: async () => [
        pr({ statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "FAILURE" }] }),
      ],
    });
    const reader = new ProjectReader(gh);
    expect((await reader.read()).prs[0]!.ciStatus).toBe("failed");
    expect((await reader.read()).prs[0]!.green).toBe(false);
  });

  it("parses the issue number off the PR branch", async () => {
    const gh = fakeGh({
      openPrs: async () => [pr(), pr({ number: 12, headRefName: "feature/x" })],
    });
    const read = await new ProjectReader(gh).read();
    expect(read.prs[0]!.issueNumber).toBe(1);
    expect(read.prs[1]!.issueNumber).toBeNull();
  });
});
