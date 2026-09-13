import { describe, expect, it } from "vitest";
import { ProjectSchema, ProjectSettingsSchema, SessionSchema } from "@pideck/shared";
import { deriveActions, deriveGlobalAction, isAssigned, orchestratorAction } from "./desired.js";
import type { IssueFacts, PrFacts, ProjectFacts } from "./read.js";

const project = ProjectSchema.parse({
  id: "my-api",
  name: "My API",
  repoUrl: "https://github.com/acme/my-api",
  owner: "acme",
  repo: "my-api",
  defaultBranch: "main",
  path: "/tmp/my-api",
});

const settings = ProjectSettingsSchema.parse({});

function session(persona: "global" | "orchestrator" | "worker" | "reviewer", overrides: Record<string, unknown> = {}) {
  return SessionSchema.parse({
    id: `s-${Math.random().toString(36).slice(2)}`,
    persona,
    projectId: persona === "global" ? null : "my-api",
    tmuxSession: `tmux-${overrides["id"] ?? "x"}`,
    spawnedAt: "2025-06-01T11:50:00Z",
    model: null,
    ...overrides,
  });
}

function issue(overrides: Partial<IssueFacts> = {}): IssueFacts {
  return {
    number: 1,
    title: "Add rate limiting",
    url: "https://github.com/acme/my-api/issues/1",
    assignees: ["acme-worker"],
    openBlockers: 0,
    comments: [],
    ...overrides,
  };
}

function pr(overrides: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 11,
    headBranch: "pideck/issue-1",
    headSha: "sha-1",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    ciStatus: "ok",
    failingChecks: [],
    green: true,
    issueNumber: 1,
    reviews: [],
    reviewComments: [],
    prComments: [],
    ...overrides,
  };
}

function facts(overrides: Partial<ProjectFacts> = {}): ProjectFacts {
  return { issues: [], prs: [], primaryLogin: "acme-worker", ...overrides };
}

function derive(
  projectFacts: ProjectFacts,
  live: ReturnType<typeof session>[] = [],
  overrides: Partial<{
    context: Map<string, number | null>;
    active: Map<string, boolean>;
    notifiedHeads: Map<number, string>;
    stallNotices: Map<string, string>;
    now: Date;
  }> = {},
) {
  return deriveActions({
    project,
    settings,
    facts: projectFacts,
    live,
    context: overrides.context ?? new Map(),
    active: overrides.active ?? new Map(),
    reviewLogin: "acme-review",
    notifiedHeads: overrides.notifiedHeads ?? new Map(),
    stallNotices: overrides.stallNotices ?? new Map(),
    now: overrides.now ?? new Date("2025-06-01T12:00:00Z"),
  });
}

function spawnWorkerActions(actions: ReturnType<typeof derive>) {
  return actions.filter((a) => a.kind === "spawn-worker");
}

describe("deriveActions — the SPEC §4 table", () => {
  it("issue open + assigned + unblocked → exactly one live worker", () => {
    const actions = derive(facts({ issues: [issue()] }));
    const spawns = spawnWorkerActions(actions);
    expect(spawns).toHaveLength(1);
    const spawn = spawns[0]!;
    if (spawn.kind !== "spawn-worker") throw new Error("expected spawn-worker");
    expect(spawn.issue.number).toBe(1);
  });

  it("a second assigned issue spawns up to workerConcurrency workers", () => {
    const actions = derive(facts({ issues: [issue({ number: 1 }), issue({ number: 2 })] }));
    expect(spawnWorkerActions(actions)).toHaveLength(2);
  });

  it("workerConcurrency caps worker spawns", () => {
    const capped = ProjectSettingsSchema.parse({ workerConcurrency: 1 });
    const actions = deriveActions({
      project,
      settings: capped,
      facts: facts({ issues: [issue({ number: 1 }), issue({ number: 2 })] }),
      live: [],
      context: new Map(),
      active: new Map(),
      reviewLogin: "acme-review",
      notifiedHeads: new Map(),
      stallNotices: new Map(),
      now: new Date("2025-06-01T12:00:00Z"),
    });
    expect(spawnWorkerActions(actions)).toHaveLength(1);
  });

  it("assigned + open blocker → no worker, and a live worker is archived", () => {
    const worker = session("worker", { issueNumber: 1 });
    const actions = derive(facts({ issues: [issue({ openBlockers: 1 })] }), [worker]);
    expect(spawnWorkerActions(actions)).toHaveLength(0);
    expect(actions).toContainEqual({ kind: "archive", session: worker, reason: "issue #1 blocked" });
  });

  it("unassigned issue → no worker; a live worker is archived", () => {
    const worker = session("worker", { issueNumber: 1 });
    const actions = derive(facts({ issues: [issue({ assignees: [] })] }), [worker]);
    expect(spawnWorkerActions(actions)).toHaveLength(0);
    expect(actions).toContainEqual({ kind: "archive", session: worker, reason: "issue #1 unassigned" });
  });

  it("closed issue → the live worker is archived", () => {
    const worker = session("worker", { issueNumber: 7 });
    const actions = derive(facts(), [worker]);
    expect(actions).toContainEqual({
      kind: "archive",
      session: worker,
      reason: "issue #7 closed or merged",
    });
  });

  it("open PR on pideck/issue-<n> attaches to issue n's worker", () => {
    const worker = session("worker", { issueNumber: 1 });
    const actions = derive(
      facts({ issues: [issue()], prs: [pr({ green: false, ciStatus: "pending" })] }),
      [worker],
    );
    expect(actions).toContainEqual({ kind: "attach-pr", session: worker, prNumber: 11 });
  });

  it("worker whose PR is merged or closed is archived", () => {
    const worker = session("worker", { issueNumber: 1, prNumber: 11 });
    const actions = derive(facts({ issues: [issue()] }), [worker]);
    expect(actions).toContainEqual({
      kind: "archive",
      session: worker,
      reason: "PR #11 merged or closed",
    });
  });

  it("PR green + not approved + no conflicts → exactly one live reviewer", () => {
    const actions = derive(facts({ prs: [pr()] }));
    const spawns = actions.filter((a) => a.kind === "spawn-reviewer");
    expect(spawns).toHaveLength(1);
    const spawn = spawns[0]!;
    if (spawn.kind !== "spawn-reviewer") throw new Error("expected spawn-reviewer");
    expect(spawn.pr.number).toBe(11);
    expect(spawn.initial).toEqual({
      lastPromptedHeadSha: "sha-1",
      lastPromptedHeadAt: "2025-06-01T12:00:00.000Z",
      lastDeliveredReviewId: null,
    });
  });

  it("no reviewer when CI is not green or the PR conflicts", () => {
    expect(derive(facts({ prs: [pr({ green: false })] })).filter((a) => a.kind === "spawn-reviewer")).toHaveLength(0);
    expect(derive(facts({ prs: [pr({ green: false, ciStatus: "pending" })] })).filter((a) => a.kind === "spawn-reviewer")).toHaveLength(0);
    expect(derive(facts({ prs: [pr({ mergeable: "CONFLICTING" })] })).filter((a) => a.kind === "spawn-reviewer")).toHaveLength(0);
    expect(derive(facts({ prs: [pr({ reviewDecision: "APPROVED" })] })).filter((a) => a.kind === "spawn-reviewer")).toHaveLength(0);
  });

  it("a second reviewer is not spawned when one is live", () => {
    const reviewer = session("reviewer", { prNumber: 11 });
    const actions = derive(facts({ prs: [pr()] }), [reviewer]);
    expect(actions.filter((a) => a.kind === "spawn-reviewer")).toHaveLength(0);
  });

  it("no reReview when CI is not green, even on a new head", () => {
    const reviewer = session("reviewer", { prNumber: 11, lastPromptedHeadSha: "old" });
    const actions = derive(
      facts({ prs: [pr({ headSha: "sha-2", green: false, ciStatus: "pending" })] }),
      [reviewer],
    );
    expect(actions.filter((a) => a.kind === "deliver")).toHaveLength(0);
  });

  it("an approved PR keeps its reviewer live and idle", () => {
    const reviewer = session("reviewer", { prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const actions = derive(facts({ prs: [pr({ reviewDecision: "APPROVED" })] }), [reviewer]);
    expect(actions.filter((a) => a.kind === "archive")).toHaveLength(0);
    expect(actions.filter((a) => a.kind === "deliver" && a.target.id === reviewer.id)).toHaveLength(0);
  });

  it("a new head on an approved PR re-arms the reviewer instead of archiving it", () => {
    const reviewer = session("reviewer", { prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const actions = derive(
      facts({ prs: [pr({ headSha: "sha-2", reviewDecision: "APPROVED" })] }),
      [reviewer],
    );
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.target.id).toBe(reviewer.id);
    expect(delivers[0]!.text).toContain("re-review");
    expect(delivers[0]!.watermark?.patch).toEqual({
      lastPromptedHeadSha: "sha-2",
      lastPromptedHeadAt: "2025-06-01T12:00:00.000Z",
      lastDeliveredReviewId: null,
    });
    expect(actions.filter((a) => a.kind === "archive")).toHaveLength(0);
  });

  it("on an approved PR the reviewer holds the baton until its fresh approval is observed", () => {
    const worker = session("worker", { issueNumber: 1, prNumber: 11, lastPromptedHeadSha: "sha-2" });
    const reviewer = session("reviewer", {
      prNumber: 11,
      lastPromptedHeadSha: "sha-2",
      lastDeliveredReviewId: 5,
    });
    const staleApproval = { id: 5, author: "acme-review", state: "APPROVED", submittedAt: null, body: null, commitId: "sha-1" };
    const comment = { id: 8, author: "acme-review", body: "one more nit", createdAt: "2025-06-01T10:00:00Z" };
    // Mid-round, the re-armed reviewer's inline comments do not steer the worker.
    const midRound = facts({
      issues: [issue()],
      prs: [pr({ headSha: "sha-2", reviewDecision: "APPROVED", reviews: [staleApproval], reviewComments: [comment] })],
    });
    expect(derive(midRound, [worker, reviewer]).filter((a) => a.kind === "deliver")).toHaveLength(0);

    // Its fresh approval ends the round: the worker reads ready, no prompt.
    const fresh = { id: 9, author: "acme-review", state: "APPROVED", submittedAt: null, body: null, commitId: "sha-1" };
    const approved = facts({
      issues: [issue()],
      prs: [pr({ headSha: "sha-2", reviewDecision: "APPROVED", reviews: [staleApproval, fresh] })],
    });
    expect(derive(approved, [worker, reviewer]).filter((a) => a.kind === "deliver")).toHaveLength(0);
  });

  it("no reviewer while the review account cannot read the repo", () => {
    const actions = derive(
      facts({ prs: [pr()], reviewAccess: "review account has no access to acme/my-api" }),
    );
    expect(actions.filter((a) => a.kind === "spawn-reviewer")).toHaveLength(0);
  });

  it("merged or closed PR → the reviewer is archived", () => {
    const reviewer = session("reviewer", { prNumber: 99 });
    const actions = derive(facts(), [reviewer]);
    expect(actions).toContainEqual({
      kind: "archive",
      session: reviewer,
      reason: "PR #99 merged or closed",
    });
  });
});

describe("deriveActions — worker deliveries", () => {
  it("CI red on a new head delivers ciRed and increments fixAttempts", () => {
    const worker = session("worker", { issueNumber: 1, lastPromptedHeadSha: "old", fixAttempts: 2 });
    const actions = derive(
      facts({ issues: [issue()], prs: [pr({ green: false, ciStatus: "failed", headSha: "sha-2", failingChecks: ["build"] })] }),
      [worker],
    );
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.target.id).toBe(worker.id);
    expect(delivers[0]!.text).toContain("build");
    expect(delivers[0]!.text).toContain("attempt 3 of 5");
    expect(delivers[0]!.watermark).toEqual({
      sessionId: worker.id,
      patch: { fixAttempts: 3, lastPromptedHeadSha: "sha-2", lastActivityAt: "2025-06-01T12:00:00.000Z" },
    });
  });

  it("exhausted fix attempts deliver the comment-status-and-idle variant", () => {
    const worker = session("worker", { issueNumber: 1, lastPromptedHeadSha: "old", fixAttempts: 5 });
    const actions = derive(
      facts({ issues: [issue()], prs: [pr({ green: false, ciStatus: "failed", headSha: "sha-2", failingChecks: ["build"] })] }),
      [worker],
    );
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.text).toContain("pideck blocked");
    expect(delivers[0]!.watermark?.patch).toEqual({
      lastPromptedHeadSha: "sha-2",
      lastActivityAt: "2025-06-01T12:00:00.000Z",
    });
  });

  it("fixAttempts reset when CI goes green", () => {
    const worker = session("worker", { issueNumber: 1, lastPromptedHeadSha: "sha-1", fixAttempts: 4 });
    const actions = derive(facts({ issues: [issue()], prs: [pr()] }), [worker]);
    const marks = actions.filter((a) => a.kind === "watermarks");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.patch).toEqual({
      fixAttempts: 0,
      lastPromptedHeadSha: "sha-1",
      lastActivityAt: "2025-06-01T12:00:00.000Z",
    });
    expect(actions.filter((a) => a.kind === "deliver")).toHaveLength(0);
  });

  it("a conflicting PR delivers prConflict once per head, not per tick", () => {
    const worker = session("worker", { issueNumber: 1, prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const conflicting = facts({ issues: [issue()], prs: [pr({ mergeable: "CONFLICTING", green: false, ciStatus: "ok" })] });
    const first = derive(conflicting, [worker]).filter((a) => a.kind === "deliver");
    expect(first).toHaveLength(1);
    expect(first[0]!.target.id).toBe(worker.id);
    expect(first[0]!.text).toContain("conflicts with main");
    expect(first[0]!.watermark?.patch).toEqual({ lastNotifiedConflictSha: "sha-1" });
    const notified = session("worker", {
      issueNumber: 1,
      prNumber: 11,
      lastPromptedHeadSha: "sha-1",
      lastNotifiedConflictSha: "sha-1",
    });
    expect(derive(conflicting, [notified]).filter((a) => a.kind === "deliver")).toHaveLength(0);
    const stillConflicting = facts({
      issues: [issue()],
      prs: [pr({ mergeable: "CONFLICTING", green: false, ciStatus: "ok", headSha: "sha-2" })],
    });
    expect(derive(stillConflicting, [notified]).filter((a) => a.kind === "deliver")).toHaveLength(1);
  });

  it("CI red on an already-prompted head delivers nothing", () => {
    const worker = session("worker", { issueNumber: 1, lastPromptedHeadSha: "sha-1", fixAttempts: 1 });
    const actions = derive(
      facts({ issues: [issue()], prs: [pr({ green: false, ciStatus: "failed", headSha: "sha-1" })] }),
      [worker],
    );
    expect(actions.filter((a) => a.kind === "deliver")).toHaveLength(0);
  });

  it("new review requesting changes delivers reviewChanges and advances the review watermark", () => {
    const worker = session("worker", { issueNumber: 1, prNumber: 11 });
    const review = { id: 5, author: "acme-review", state: "CHANGES_REQUESTED", submittedAt: null, body: null, commitId: "sha-1" };
    const actions = derive(
      facts({ issues: [issue()], prs: [pr({ green: false, ciStatus: "pending", reviews: [review] })] }),
      [worker],
    );
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.text).toContain("PR #11");
    expect(delivers[0]!.watermark?.patch).toEqual({
      lastDeliveredReviewId: 5,
      lastAddressedHeadSha: "sha-1",
    });
  });

  it("new PR review comments deliver reviewChanges and advance the comment watermark", () => {
    const worker = session("worker", { issueNumber: 1, prNumber: 11 });
    const comment = { id: 8, author: "acme-review", body: "off by one", createdAt: "2025-06-01T10:00:00Z" };
    const actions = derive(
      facts({ issues: [issue()], prs: [pr({ green: false, ciStatus: "pending", reviewComments: [comment] })] }),
      [worker],
    );
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.watermark?.patch).toEqual({
      lastDeliveredPrCommentId: 8,
      lastAddressedHeadSha: "sha-1",
    });
  });

  it("a new PR conversation comment (the failed-alignment channel) reaches the worker", () => {
    const worker = session("worker", { issueNumber: 1, prNumber: 11 });
    const comment = { id: 9, author: "acme-worker", body: "alignment failed: wrong field", createdAt: "2025-06-01T10:00:00Z" };
    const actions = derive(
      facts({ issues: [issue()], prs: [pr({ green: false, ciStatus: "pending", prComments: [comment] })] }),
      [worker],
    );
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect((delivers[0] as { text: string }).text).toContain("PR #11");
    expect(delivers[0]!.watermark?.patch).toEqual({
      lastDeliveredPrCommentId: 9,
      lastAddressedHeadSha: "sha-1",
      lastActivityAt: "2025-06-01T12:00:00.000Z",
    });
  });

  it("opening the PR is activity and the head is attributed from first sight", () => {
    const worker = session("worker", { issueNumber: 1 });
    const actions = derive(
      facts({ issues: [issue()], prs: [pr({ green: false, ciStatus: "pending" })] }),
      [worker],
    );
    expect(actions).toContainEqual({ kind: "attach-pr", session: worker, prNumber: 11 });
    const marks = actions.filter((a) => a.kind === "watermarks");
    expect(marks[0]!.patch).toEqual({
      lastPromptedHeadSha: "sha-1",
      lastActivityAt: "2025-06-01T12:00:00.000Z",
    });
  });

  it("a freshly pushed worker with pending CI is not stalled", () => {
    // First tick: PR attached, head attributed, activity recorded.
    const worker = session("worker", { issueNumber: 1 });
    const attached = derive(
      facts({ issues: [issue()], prs: [pr({ green: false, ciStatus: "pending" })] }),
      [worker],
    );
    const patch = attached.find((a) => a.kind === "watermarks")!.patch;

    // Next tick, 15 minutes later: no new GitHub facts, no stall notice —
    // the push that opened the PR was attributed, not lost to a spawn-time
    // baseline.
    const worker2 = session("worker", {
      issueNumber: 1,
      prNumber: 11,
      lastPromptedHeadSha: patch.lastPromptedHeadSha,
      lastActivityAt: patch.lastActivityAt,
    });
    const orch = session("orchestrator");
    const again = derive(
      facts({ issues: [issue()], prs: [pr({ green: false, ciStatus: "pending" })] }),
      [worker2, orch],
      { now: new Date("2025-06-01T12:15:00Z") },
    );
    expect(again.filter((a) => a.kind === "deliver")).toHaveLength(0);
  });

  it("a review requesting changes and new comments in one tick deliver one reviewChanges", () => {
    const worker = session("worker", { issueNumber: 1, prNumber: 11 });
    const review = { id: 5, author: "acme-review", state: "CHANGES_REQUESTED", submittedAt: null, body: null, commitId: "sha-1" };
    const comment = { id: 8, author: "acme-review", body: "and this", createdAt: "2025-06-01T10:00:00Z" };
    const actions = derive(
      facts({ issues: [issue()], prs: [pr({ green: false, ciStatus: "pending", reviews: [review], reviewComments: [comment] })] }),
      [worker],
    );
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.watermark?.patch).toEqual({
      lastDeliveredPrCommentId: 8,
      lastDeliveredReviewId: 5,
      lastAddressedHeadSha: "sha-1",
    });
  });

  it("a new issue comment without the marker wakes the worker, whoever wrote it", () => {
    const worker = session("worker", { issueNumber: 1 });
    const comment = { id: 3, author: "acme-worker", body: "answer", createdAt: "2025-06-01T10:00:00Z" };
    const orch = session("orchestrator");
    const actions = derive(facts({ issues: [issue({ comments: [comment] })] }), [worker, orch]);
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.target.id).toBe(worker.id);
    expect(delivers[0]!.text).toContain("New comment on issue #1");
    expect(delivers[0]!.watermark?.patch).toEqual({ lastDeliveredIssueCommentId: 3 });
  });

  it("a thread longer than one page delivers everything: the watermark lands on the true last comment", () => {
    const worker = session("worker", {
      issueNumber: 1,
      lastDeliveredIssueCommentId: 100,
    });
    // 150 comments; the worker has been told up to #100, so #101–#150 are new.
    const comments = Array.from({ length: 150 }, (_, i) => ({
      id: i + 1,
      author: "someone",
      body: i === 149 ? "latest steer" : "history",
      createdAt: "2025-06-01T10:00:00Z",
    }));
    const actions = derive(facts({ issues: [issue({ comments })] }), [worker]);
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.text).toContain("issuecomment-150");
    expect(delivers[0]!.watermark?.patch).toEqual({ lastDeliveredIssueCommentId: 150 });

    // The next tick with the watermark applied: nothing re-delivered, none skipped.
    const caughtUp = session("worker", {
      issueNumber: 1,
      lastDeliveredIssueCommentId: 150,
    });
    const nextTick = derive(facts({ issues: [issue({ comments })] }), [caughtUp]);
    expect(nextTick.filter((a) => a.kind === "deliver")).toHaveLength(0);
  });

  it("a BLOCKED: comment goes to the orchestrator instead", () => {
    const worker = session("worker", { issueNumber: 1 });
    const comment = { id: 4, author: "acme-worker", body: "BLOCKED: missing decision", createdAt: "2025-06-01T10:00:00Z" };
    const orch = session("orchestrator");
    const actions = derive(facts({ issues: [issue({ comments: [comment] })] }), [worker, orch]);
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.target.id).toBe(orch.id);
    expect(delivers[0]!.text).toContain("blocked on issue #1");
    expect(delivers[0]!.watermark?.patch).toEqual({
      lastDeliveredIssueCommentId: 4,
      lastActivityAt: "2025-06-01T12:00:00.000Z",
    });
  });

  it("a BLOCKED: comment with no live orchestrator is deferred, not dropped", () => {
    const worker = session("worker", { issueNumber: 1 });
    const comment = { id: 4, author: "acme-worker", body: "BLOCKED: blocked", createdAt: "2025-06-01T10:00:00Z" };
    const actions = derive(facts({ issues: [issue({ comments: [comment] })] }), [worker]);
    expect(actions.filter((a) => a.kind === "deliver")).toHaveLength(0);
    // Only the activity clock advanced; the comment watermark is untouched.
    const marks = actions.filter((a) => a.kind === "watermarks");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.patch).toEqual({ lastActivityAt: "2025-06-01T12:00:00.000Z" });
    // Nothing consumed: a later tick with an orchestrator delivers it.
    const orch = session("orchestrator");
    const next = derive(facts({ issues: [issue({ comments: [comment] })] }), [worker, orch]);
    expect(next.some((a) => a.kind === "deliver" && a.target.id === orch.id)).toBe(true);
  });

  it("a silent worker is reported stalled to the orchestrator once, then the clock restarts", () => {
    const worker = session("worker", {
      issueNumber: 1,
      lastActivityAt: "2025-06-01T11:00:00Z",
    });
    const orch = session("orchestrator");
    const actions = derive(facts({ issues: [issue()] }), [worker, orch]);
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.target.id).toBe(orch.id);
    expect(delivers[0]!.text).toContain("has been silent for 45 minutes");
    expect(delivers[0]!.watermark?.patch).toEqual({ lastActivityAt: "2025-06-01T12:00:00.000Z" });

    // With the notice applied (as apply would record it), no repeat while
    // the silence continues...
    const noticed = derive(facts({ issues: [issue()] }), [worker, orch], {
      stallNotices: new Map([[worker.id, "2025-06-01T12:00:00.000Z"]]),
    });
    expect(noticed.filter((a) => a.kind === "deliver")).toHaveLength(0);

    // ...but a new silence after activity reports again.
    const active = session("worker", { issueNumber: 1, lastActivityAt: "2025-06-01T12:05:00Z" });
    const noticed2 = derive(facts({ issues: [issue()] }), [active, orch], {
      now: new Date("2025-06-01T13:00:00Z"),
      stallNotices: new Map([[active.id, "2025-06-01T12:00:00.000Z"]]),
    });
    expect(noticed2.filter((a) => a.kind === "deliver" && a.target.id === orch.id)).toHaveLength(1);
  });

  it("a worker observed pushing or commenting counts as active, not stalled", () => {
    const worker = session("worker", { issueNumber: 1, lastPromptedHeadSha: "old", lastActivityAt: "2025-06-01T11:00:00Z" });
    const orch = session("orchestrator");
    const actions = derive(
      facts({ issues: [issue()], prs: [pr({ green: false, ciStatus: "pending", headSha: "new-head" })] }),
      [worker, orch],
    );
    expect(actions.filter((a) => a.kind === "deliver" && a.target.id === orch.id)).toHaveLength(0);
    const marks = actions.filter((a) => a.kind === "watermarks");
    expect(marks[0]!.patch).toEqual({
      lastPromptedHeadSha: "new-head",
      lastActivityAt: "2025-06-01T12:00:00.000Z",
    });
  });

  it("context usage over the limit archives the worker for replacement", () => {
    const worker = session("worker", { issueNumber: 1 });
    const actions = derive(facts({ issues: [issue()] }), [worker], {
      context: new Map([[worker.id, 95]]),
    });
    expect(actions).toContainEqual({ kind: "archive", session: worker, reason: "context limit" });
  });
});

describe("deriveActions — the baton hand-off", () => {
  it("a reviewer round starts only while the worker is quiet: no spawn while it addresses review", () => {
    const worker = session("worker", {
      issueNumber: 1,
      prNumber: 11,
      lastPromptedHeadSha: "sha-1",
      lastAddressedHeadSha: "sha-1",
    });
    const addressing = facts({
      issues: [issue()],
      prs: [pr({ reviewDecision: "CHANGES_REQUESTED" })],
    });
    expect(derive(addressing, [worker]).filter((a) => a.kind === "spawn-reviewer")).toHaveLength(0);

    // A push answers the prompt: a fresh reviewer may take the new head.
    const pushed = facts({
      issues: [issue()],
      prs: [pr({ headSha: "sha-2", reviewDecision: "CHANGES_REQUESTED" })],
    });
    const spawns = derive(pushed, [worker]).filter((a) => a.kind === "spawn-reviewer");
    expect(spawns).toHaveLength(1);
    expect((spawns[0] as { initial: unknown }).initial).toEqual({
      lastPromptedHeadSha: "sha-2",
      lastPromptedHeadAt: "2025-06-01T12:00:00.000Z",
      lastDeliveredReviewId: null,
    });
  });

  it("a reviewer replacement does not re-review the head the worker is addressing", () => {
    const worker = session("worker", {
      issueNumber: 1,
      prNumber: 11,
      lastPromptedHeadSha: "sha-1",
      lastAddressedHeadSha: "sha-1",
    });
    const actions = derive(
      facts({ issues: [issue()], prs: [pr({ reviewDecision: "CHANGES_REQUESTED" })] }),
      [worker],
    );
    expect(actions.filter((a) => a.kind === "spawn-reviewer")).toHaveLength(0);
  });

  it("a re-review waits for the worker to be quiet (double-push)", () => {
    const reviewer = session("reviewer", { prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const redeliveries = (headSha: string, green: boolean) =>
      derive(facts({ issues: [issue()], prs: [pr({ headSha, green, ciStatus: green ? "ok" : "pending" })] }), [
        reviewer,
      ]).filter((a) => a.kind === "deliver" && a.target.id === reviewer.id);

    // First push: CI pending, head not quiet — no round.
    expect(redeliveries("sha-2", false)).toHaveLength(0);
    // Second push before the first was reviewed: the head still is not quiet.
    expect(redeliveries("sha-3", false)).toHaveLength(0);
    // The head is stable and green: the reviewer is re-armed once.
    const reReviews = redeliveries("sha-3", true) as Extract<
      ReturnType<typeof derive>[number],
      { kind: "deliver" }
    >[];
    expect(reReviews).toHaveLength(1);
    expect(reReviews[0]!.watermark?.patch).toEqual({
      lastPromptedHeadSha: "sha-3",
      lastPromptedHeadAt: "2025-06-01T12:00:00.000Z",
      lastDeliveredReviewId: null,
    });
  });

  it("inline comments by the review account during its round do not steer the worker", () => {
    const worker = session("worker", { issueNumber: 1, prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const reviewer = session("reviewer", { prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const comment = { id: 8, author: "acme-review", body: "off by one", createdAt: "2025-06-01T10:00:00Z" };
    const inFlight = facts({
      issues: [issue()],
      prs: [pr({ green: false, ciStatus: "pending", reviewComments: [comment] })],
    });
    const actions = derive(inFlight, [worker, reviewer]);
    expect(actions.filter((a) => a.kind === "deliver")).toHaveLength(0);
    // But the comments are consumed: the submission that ends the round
    // points the worker at the whole review.
    const marks = actions.filter((a) => a.kind === "watermarks");
    expect(marks[0]!.patch).toEqual({ lastDeliveredPrCommentId: 8 });
  });

  it("the review submission ends the round and steers the worker once", () => {
    const worker = session("worker", { issueNumber: 1, prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const reviewer = session("reviewer", { prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const comment = { id: 8, author: "acme-review", body: "off by one", createdAt: "2025-06-01T10:00:00Z" };
    const review = { id: 9, author: "acme-review", state: "CHANGES_REQUESTED", submittedAt: null, body: null, commitId: "sha-1" };
    const actions = derive(
      facts({
        issues: [issue()],
        prs: [pr({ green: false, ciStatus: "pending", reviews: [review], reviewComments: [comment] })],
      }),
      [worker, reviewer],
    );
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.target.id).toBe(worker.id);
    expect(delivers[0]!.watermark?.patch).toEqual({
      lastDeliveredPrCommentId: 8,
      lastDeliveredReviewId: 9,
      lastAddressedHeadSha: "sha-1",
    });
  });

  it("a human comment during a reviewer round is delivered immediately", () => {
    const worker = session("worker", { issueNumber: 1, prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const reviewer = session("reviewer", { prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const comment = { id: 10, author: "acme-user", body: "this one matters", createdAt: "2025-06-01T10:00:00Z" };
    const actions = derive(
      facts({ issues: [issue()], prs: [pr({ green: false, ciStatus: "pending", reviewComments: [comment] })] }),
      [worker, reviewer],
    );
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.target.id).toBe(worker.id);
    expect(delivers[0]!.watermark?.patch).toEqual({
      lastDeliveredPrCommentId: 10,
      lastAddressedHeadSha: "sha-1",
    });
  });

  it("CI red during a reviewer round prompts nobody; a push re-arms through the quiet rule", () => {
    // The round is in flight and CI has gone red on the reviewed head. The
    // worker's watermark is unset, so without the baton this would read as a
    // push — the gate is what keeps the worker quiet.
    const worker = session("worker", { issueNumber: 1, prNumber: 11 });
    const reviewer = session("reviewer", { prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const redDuringRound = facts({
      issues: [issue()],
      prs: [pr({ green: false, ciStatus: "failed", failingChecks: ["build"] })],
    });
    const actions = derive(redDuringRound, [worker, reviewer]);
    expect(actions.filter((a) => a.kind === "deliver")).toHaveLength(0);

    // A push ends the round: CI red on the new head reaches the worker.
    const pushed = session("worker", {
      issueNumber: 1,
      prNumber: 11,
      lastPromptedHeadSha: "sha-2",
      fixAttempts: 1,
    });
    const redOnNewHead = facts({
      issues: [issue()],
      prs: [pr({ headSha: "sha-3", green: false, ciStatus: "failed", failingChecks: ["build"] })],
    });
    const next = derive(redOnNewHead, [pushed, reviewer]);
    expect(next.filter((a) => a.kind === "deliver" && a.target.id === pushed.id)).toHaveLength(1);
  });
});

describe("deriveActions — reviewer deliveries and orchestrator notices", () => {
  it("a new head since the reviewer's last review triggers re-review", () => {
    const reviewer = session("reviewer", { prNumber: 11, lastPromptedHeadSha: "old" });
    const actions = derive(facts({ prs: [pr({ headSha: "sha-2" })] }), [reviewer]);
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.target.id).toBe(reviewer.id);
    expect(delivers[0]!.text).toContain("re-review");
    expect(delivers[0]!.watermark?.patch).toEqual({
      lastPromptedHeadSha: "sha-2",
      lastPromptedHeadAt: "2025-06-01T12:00:00.000Z",
      lastDeliveredReviewId: null,
    });
  });

  it("approvedGreen reaches the orchestrator once per head", () => {
    const orch = session("orchestrator");
    const heads = new Map<number, string>();
    const approval = { id: 5, author: "acme-review", state: "APPROVED", submittedAt: null, body: null, commitId: "sha-1" };
    const approved = facts({ prs: [pr({ reviews: [approval] })] });
    const first = derive(approved, [orch], { notifiedHeads: heads });
    const delivers = first.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect((delivers[0] as { text: string }).text).toContain("PR #11 for issue #1 is approved and green");

    // apply marks the head after a successful send (as the daemon would).
    heads.set(11, "sha-1");
    const second = derive(approved, [orch], { notifiedHeads: heads });
    expect(second.filter((a) => a.kind === "deliver")).toHaveLength(0);

    const atNewHead = facts({
      prs: [pr({ headSha: "sha-9", reviews: [{ ...approval, id: 6, commitId: "sha-9" }] })],
    });
    const third = derive(atNewHead, [orch], { notifiedHeads: heads });
    expect(third.filter((a) => a.kind === "deliver")).toHaveLength(1);
  });

  it("a human approval alone never triggers approvedGreen; a stale review-account approval does not either", () => {
    const orch = session("orchestrator");
    // GitHub says APPROVED, but the review account's newest review is a
    // changes-requested at an older head: the gate stays closed.
    const humanApproved = facts({
      prs: [
        pr({
          reviewDecision: "APPROVED",
          reviews: [
            { id: 4, author: "acme-review", state: "CHANGES_REQUESTED", submittedAt: null, body: null, commitId: "sha-1" },
            { id: 5, author: "acme-human", state: "APPROVED", submittedAt: null, body: null, commitId: "sha-1" },
          ],
        }),
      ],
    });
    expect(derive(humanApproved, [orch]).filter((a) => a.kind === "deliver")).toHaveLength(0);

    // The review account approved — but at a head the worker has since
    // pushed past: also closed.
    const stale = facts({
      prs: [
        pr({
          headSha: "sha-2",
          reviewDecision: "APPROVED",
          reviews: [{ id: 5, author: "acme-review", state: "APPROVED", submittedAt: null, body: null, commitId: "sha-1" }],
        }),
      ],
    });
    expect(derive(stale, [orch]).filter((a) => a.kind === "deliver")).toHaveLength(0);
  });

  it("approvedGreen is deferred while no orchestrator is live", () => {
    const heads = new Map<number, string>();
    const approval = { id: 5, author: "acme-review", state: "APPROVED", submittedAt: null, body: null, commitId: "sha-1" };
    const actions = derive(facts({ prs: [pr({ reviews: [approval] })] }), [], { notifiedHeads: heads });
    expect(actions.filter((a) => a.kind === "deliver")).toHaveLength(0);
    expect(heads.size).toBe(0);
  });

  it("approval with inline comments delivers reviewChanges but holds approvedGreen back", () => {
    const worker = session("worker", { issueNumber: 1, prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const reviewer = session("reviewer", { prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const approval = { id: 5, author: "acme-review", state: "APPROVED", submittedAt: null, body: null, commitId: "sha-1" };
    const comment = { id: 8, author: "acme-review", body: "one more nit", createdAt: "2025-06-01T10:00:00Z" };
    const actions = derive(
      facts({
        issues: [issue()],
        prs: [pr({ reviewDecision: "APPROVED", reviews: [approval], reviewComments: [comment] })],
      }),
      [worker, reviewer],
    );
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.target.id).toBe(worker.id);
    expect(delivers[0]!.text).toContain("review activity");
  });

  it("approvedGreen waits until the worker answers the comments it was told about", () => {
    const orch = session("orchestrator");
    const reviewer = session("reviewer", { prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const approval = { id: 5, author: "acme-review", state: "APPROVED", submittedAt: null, body: null, commitId: "sha-1" };
    const comment = { id: 8, author: "acme-review", body: "one more nit", createdAt: "2025-06-01T10:00:00Z" };
    const told = facts({
      issues: [issue()],
      prs: [pr({ reviewDecision: "APPROVED", reviews: [approval], reviewComments: [comment] })],
    });
    // The watermarks the delivery tick recorded: the worker was told about
    // the comments for this head and has not answered yet.
    const addressing = session("worker", {
      issueNumber: 1,
      prNumber: 11,
      lastPromptedHeadSha: "sha-1",
      lastDeliveredPrCommentId: 8,
      lastDeliveredReviewId: 5,
      lastAddressedHeadSha: "sha-1",
    });
    expect(derive(told, [addressing, reviewer, orch]).filter((a) => a.kind === "deliver")).toHaveLength(0);

    // The worker replies in the thread (nothing to push): the notice goes out.
    const reply = { id: 12, author: "acme-worker", body: "addressed", createdAt: "2025-06-01T11:30:00Z" };
    const answered = facts({
      issues: [issue()],
      prs: [pr({ reviewDecision: "APPROVED", reviews: [approval], reviewComments: [comment, reply] })],
    });
    const delivers = derive(answered, [addressing, reviewer, orch]).filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.target.id).toBe(orch.id);
    expect((delivers[0] as { text: string }).text).toContain("approved and green");
  });

  it("a push after approval-with-comments holds approvedGreen until the fresh approval", () => {
    const orch = session("orchestrator");
    const reviewer = session("reviewer", { prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const approval = { id: 5, author: "acme-review", state: "APPROVED", submittedAt: null, body: null, commitId: "sha-1" };
    // The worker pushed fixes for the comments: the old approval is stale.
    const pushed = facts({
      issues: [issue()],
      prs: [pr({ headSha: "sha-2", reviewDecision: "APPROVED", reviews: [approval] })],
    });
    expect(derive(pushed, [session("worker", { issueNumber: 1, prNumber: 11 }), reviewer, orch]).filter(
      (a) => a.kind === "deliver" && a.target.id === orch.id,
    )).toHaveLength(0);

    // The re-armed reviewer approves the new head without comments: notify.
    const reApproved = {
      id: 9,
      author: "acme-review",
      state: "APPROVED",
      submittedAt: null,
      body: null,
      commitId: "sha-2",
    };
    const fresh = facts({
      issues: [issue()],
      prs: [pr({ headSha: "sha-2", reviewDecision: "APPROVED", reviews: [approval, reApproved] })],
    });
    const armed = session("reviewer", { prNumber: 11, lastPromptedHeadSha: "sha-2", lastDeliveredReviewId: 5 });
    const delivers = derive(fresh, [session("worker", { issueNumber: 1, prNumber: 11 }), armed, orch]).filter(
      (a) => a.kind === "deliver" && a.target.id === orch.id,
    );
    expect(delivers).toHaveLength(1);
  });

  it("an approval at the armed head without comments still notifies promptly", () => {
    const orch = session("orchestrator");
    const worker = session("worker", { issueNumber: 1, prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const reviewer = session("reviewer", { prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const approval = { id: 5, author: "acme-review", state: "APPROVED", submittedAt: null, body: null, commitId: "sha-1" };
    const actions = derive(
      facts({ issues: [issue()], prs: [pr({ reviewDecision: "APPROVED", reviews: [approval] })] }),
      [worker, reviewer, orch],
    );
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.target.id).toBe(orch.id);
  });
});

describe("deriveActions — the reviewer stall bound", () => {
  it("a dead-quiet reviewer past the stall bound is nudged once per round", () => {
    // Armed at spawn an hour ago; no review filed since; probe says idle.
    const reviewer = session("reviewer", {
      prNumber: 11,
      lastPromptedHeadSha: "sha-1",
      lastPromptedHeadAt: "2025-06-01T11:00:00Z",
    });
    const actions = derive(facts({ prs: [pr()] }), [reviewer]);
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.target.id).toBe(reviewer.id);
    expect(delivers[0]!.text).toContain("no review from you");
    // The nudge re-arms the round's clock so the replace stage waits a full
    // stall window before firing.
    expect(delivers[0]!.watermark?.patch).toEqual({
      lastPromptedHeadSha: "sha-1",
      lastPromptedHeadAt: "2025-06-01T12:00:00.000Z",
      lastDeliveredReviewId: null,
    });
    expect((delivers[0] as { stallNotice?: unknown }).stallNotice).toEqual({
      sessionId: reviewer.id,
      at: "2025-06-01T12:00:00.000Z",
    });
    expect(actions.filter((a) => a.kind === "archive")).toHaveLength(0);
  });

  it("a reviewer still mid-turn is left alone, however slow", () => {
    const reviewer = session("reviewer", {
      prNumber: 11,
      lastPromptedHeadSha: "sha-1",
      lastPromptedHeadAt: "2025-06-01T11:00:00Z",
    });
    const actions = derive(facts({ prs: [pr()] }), [reviewer], {
      active: new Map([[reviewer.id, true]]),
    });
    expect(actions.filter((a) => a.kind === "deliver")).toHaveLength(0);
    expect(actions.filter((a) => a.kind === "archive")).toHaveLength(0);
  });

  it("inside the stall bound nothing is nudged", () => {
    const reviewer = session("reviewer", {
      prNumber: 11,
      lastPromptedHeadSha: "sha-1",
      lastPromptedHeadAt: "2025-06-01T11:20:00Z",
    });
    const actions = derive(facts({ prs: [pr()] }), [reviewer]);
    expect(actions.filter((a) => a.kind === "deliver")).toHaveLength(0);
  });

  it("a nudged reviewer that stays dead-quiet is replaced and the orchestrator is told", () => {
    const reviewer = session("reviewer", {
      prNumber: 11,
      lastPromptedHeadSha: "sha-1",
      lastPromptedHeadAt: "2025-06-01T12:00:00Z",
    });
    const orch = session("orchestrator");
    // The nudge was sent at 12:00, re-arming the clock; the silence outlived
    // the re-armed bound.
    const actions = derive(facts({ prs: [pr()] }), [reviewer, orch], {
      now: new Date("2025-06-01T12:46:00Z"),
      stallNotices: new Map([[reviewer.id, "2025-06-01T12:00:00.000Z"]]),
    });
    expect(actions).toContainEqual({
      kind: "archive",
      session: reviewer,
      reason: "reviewer stalled on PR #11",
    });
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.target.id).toBe(orch.id);
    expect(delivers[0]!.text).toContain("The reviewer for PR #11 has been silent for 45 minutes");
    expect(actions.filter((a) => a.kind === "spawn-reviewer")).toHaveLength(0);
  });

  it("the replacement stage fires even without an orchestrator to notify", () => {
    const reviewer = session("reviewer", {
      prNumber: 11,
      lastPromptedHeadSha: "sha-1",
      lastPromptedHeadAt: "2025-06-01T12:00:00Z",
    });
    const actions = derive(facts({ prs: [pr()] }), [reviewer], {
      now: new Date("2025-06-01T12:46:00Z"),
      stallNotices: new Map([[reviewer.id, "2025-06-01T12:00:00.000Z"]]),
    });
    expect(actions).toContainEqual({
      kind: "archive",
      session: reviewer,
      reason: "reviewer stalled on PR #11",
    });
    expect(actions.filter((a) => a.kind === "deliver")).toHaveLength(0);
  });

  it("a fresh round re-arms the bound: the nudge, not the replacement, fires again", () => {
    const reviewer = session("reviewer", {
      prNumber: 11,
      lastPromptedHeadSha: "sha-2",
      lastPromptedHeadAt: "2025-06-01T12:30:00Z",
    });
    const orch = session("orchestrator");
    // The mark is older than the new round's arming time (a new head
    // re-armed the reviewer via re-review after an earlier nudge).
    const actions = derive(
      facts({ issues: [issue()], prs: [pr({ headSha: "sha-2" })] }),
      [reviewer, orch],
      {
        now: new Date("2025-06-01T13:20:00Z"),
        stallNotices: new Map([[reviewer.id, "2025-06-01T12:00:00.000Z"]]),
      },
    );
    const delivers = actions.filter((a) => a.kind === "deliver");
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.target.id).toBe(reviewer.id);
    expect(actions.filter((a) => a.kind === "archive")).toHaveLength(0);
  });

  it("a round concluded by a submission or a fresh approval is never stalled", () => {
    const worker = session("worker", { issueNumber: 1, prNumber: 11, lastPromptedHeadSha: "sha-1" });
    const reviewer = session("reviewer", {
      prNumber: 11,
      lastPromptedHeadSha: "sha-1",
      lastPromptedHeadAt: "2025-06-01T10:00:00Z",
      lastDeliveredReviewId: 4,
    });
    const submission = {
      id: 5,
      author: "acme-review",
      state: "CHANGES_REQUESTED",
      submittedAt: null,
      body: null,
      commitId: "sha-1",
    };
    const withSubmission = derive(
      facts({ issues: [issue()], prs: [pr({ green: false, ciStatus: "pending", reviews: [submission] })] }),
      [worker, reviewer],
    );
    expect(withSubmission.filter((a) => a.kind === "deliver")).toHaveLength(1); // reviewChanges to the worker
    expect(withSubmission.filter((a) => a.kind === "deliver" && a.target.id === reviewer.id)).toHaveLength(0);

    const approval = { ...submission, state: "APPROVED" };
    const approved = derive(
      facts({ issues: [issue()], prs: [pr({ reviewDecision: "APPROVED", reviews: [approval] })] }),
      [worker, reviewer, session("orchestrator")],
    );
    expect(approved.filter((a) => a.kind === "archive")).toHaveLength(0);
  });
});

describe("ensure sessions", () => {
  it("one orchestrator per project, briefed on (re)launch", () => {
    const spawned = orchestratorAction({
      project,
      settings,
      facts: facts({ issues: [issue()] }),
      live: [],
      context: new Map(),
      reviewLogin: "acme-review",
      now: new Date("2025-06-01T12:00:00Z"),
    });
    expect(spawned?.kind).toBe("spawn-orchestrator");
    if (spawned?.kind === "spawn-orchestrator") {
      expect(spawned.briefing).toContain("Briefing for My API");
      expect(spawned.briefing).toContain("assigned: #1 Add rate limiting");
    }
    const existing = orchestratorAction({
      project,
      settings,
      facts: facts(),
      live: [session("orchestrator")],
      context: new Map(),
      reviewLogin: "acme-review",
      now: new Date("2025-06-01T12:00:00Z"),
    });
    expect(existing).toBeNull();
  });

  it("one global session per install", () => {
    expect(deriveGlobalAction([])).toEqual({ kind: "spawn-global" });
    expect(deriveGlobalAction([session("global")])).toBeNull();
  });

  it("assignment resolves against the primary login", () => {
    expect(isAssigned(issue(), "acme-worker")).toBe(true);
    expect(isAssigned(issue(), "someone-else")).toBe(false);
    expect(isAssigned(issue({ assignees: [] }), null)).toBe(false);
    expect(isAssigned(issue(), null)).toBe(true);
  });
});
