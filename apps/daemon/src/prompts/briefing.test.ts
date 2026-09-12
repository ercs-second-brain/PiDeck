import { describe, expect, it } from "vitest";
import type { Project } from "@pideck/shared";
import { buildBriefing, type BriefingIssue, type BriefingPr } from "./briefing.js";

const project: Project = {
  id: "my-api",
  name: "My API",
  repoUrl: "https://github.com/acme/my-api",
  owner: "acme",
  repo: "my-api",
  defaultBranch: "main",
  path: "/home/me/my-api",
};

const session = {
  id: "s-worker",
  persona: "worker",
  projectId: "my-api",
  issueNumber: 12,
  tmuxSession: "pideck-s-worker",
  spawnedAt: "2025-01-01T00:00:00Z",
  model: null,
  lastPromptedHeadSha: null,
  lastDeliveredIssueCommentId: null,
  lastDeliveredPrCommentId: null,
  lastDeliveredReviewId: null,
  lastNotifiedConflictSha: null,
  lastAddressedHeadSha: null,
  fixAttempts: 0,
  lastActivityAt: null,
} as const;

function issue(overrides: Partial<BriefingIssue>): BriefingIssue {
  return { number: 1, title: "Do a thing", blocked: false, assignee: null, ...overrides };
}

function pr(overrides: Partial<BriefingPr>): BriefingPr {
  return { number: 21, issueNumber: null, ci: "pending", review: "pending", ...overrides };
}

describe("buildBriefing", () => {
  it("produces a single pane-safe line with every group", () => {
    const line = buildBriefing({
      project,
      issues: [
        issue({ number: 12, title: "Add rate limiting", assignee: "me" }),
        issue({ number: 9, title: "Add retries", blocked: true, assignee: "me" }),
        issue({ number: 20, title: "Docs pass" }),
      ],
      prs: [pr({ issueNumber: 12, ci: "green", review: "pending" })],
      sessions: [session],
    });
    expect(line).not.toContain("\n");
    expect(line).toContain("Briefing for My API (acme/my-api, branch main)");
    expect(line).toContain("assigned: #12 Add rate limiting");
    expect(line).toContain("blocked: #9 Add retries");
    expect(line).toContain("unassigned: #20 Docs pass");
    expect(line).toContain("PRs: #21 for #12 CI green, review pending");
    expect(line).toContain("live: worker #12 (s-worker)");
    expect(line).toContain("project memory: docs/ on main");
  });

  it("formats reviewer and orchestrator sessions", () => {
    const line = buildBriefing({
      project,
      issues: [],
      prs: [],
      sessions: [
        { ...session, id: "s-orch", persona: "orchestrator", issueNumber: undefined },
        { ...session, id: "s-rev", persona: "reviewer", issueNumber: undefined, prNumber: 21 },
      ],
    });
    expect(line).toContain("orchestrator (s-orch)");
    expect(line).toContain("reviewer PR #21 (s-rev)");
  });

  it("states empty groups explicitly so a quiet repo reads as quiet", () => {
    const line = buildBriefing({ project, issues: [], prs: [], sessions: [] });
    expect(line).toContain("no open issues");
    expect(line).toContain("no open PRs");
    expect(line).toContain("no live sessions");
    expect(line).toContain("project memory: docs/ on main");
  });

  it("still omits the empty assigned/blocked/unassigned subgroups when issues exist", () => {
    const line = buildBriefing({ project, issues: [issue({})], prs: [], sessions: [] });
    expect(line).toBe(
      "Briefing for My API (acme/my-api, branch main): " +
        "unassigned: #1 Do a thing; no open PRs; no live sessions; " +
        "project memory: docs/ on main.",
    );
  });
});