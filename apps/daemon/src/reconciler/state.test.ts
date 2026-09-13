import { describe, expect, it } from "vitest";
import { SessionSchema } from "@pideck/shared";
import { deriveState, type SessionStateFacts } from "./state.js";

function session(persona: "worker" | "reviewer" | "orchestrator" | "global", overrides: Record<string, unknown> = {}) {
  return SessionSchema.parse({
    id: "s-1",
    persona,
    projectId: persona === "global" ? null : "my-api",
    tmuxSession: "tmux-x",
    spawnedAt: "2025-06-01T00:00:00Z",
    model: null,
    ...overrides,
  });
}

const facts: SessionStateFacts = {
  pr: null,
  issueBlocked: false,
  fixAttemptsExhausted: false,
  batonHolder: null,
};

describe("deriveState — the eight worker states", () => {
  it("an archived session is done", () => {
    const view = deriveState(session("worker", { archivedAt: "2025-06-01T10:00:00Z" }), facts);
    expect(view.state).toBe("done");
    expect(view.status).toContain("archived");
  });

  it("a worker without a PR is working", () => {
    const view = deriveState(session("worker", { issueNumber: 12 }), facts);
    expect(view.state).toBe("working");
    expect(view.status).toBe("working on #12");
  });

  it("a worker with pending CI is ci", () => {
    const view = deriveState(
      session("worker", { issueNumber: 12, prNumber: 21 }),
      { ...facts, pr: { ciStatus: "pending", reviewDecision: null, mergeable: "MERGEABLE", approvedAtHead: false } },
    );
    expect(view.state).toBe("ci");
    expect(view.status).toBe("CI running for PR #21");
  });

  it("a worker with failing CI is fixing", () => {
    const view = deriveState(
      session("worker", { issueNumber: 12, prNumber: 21 }),
      { ...facts, pr: { ciStatus: "failed", reviewDecision: null, mergeable: "MERGEABLE", approvedAtHead: false } },
    );
    expect(view.state).toBe("fixing");
    expect(view.status).toBe("fixing CI on PR #21");
  });

  it("a worker whose PR conflicts with main is fixing, not awaiting review", () => {
    const view = deriveState(
      session("worker", { issueNumber: 12, prNumber: 21 }),
      { ...facts, pr: { ciStatus: "ok", reviewDecision: null, mergeable: "CONFLICTING", approvedAtHead: false } },
    );
    expect(view.state).toBe("fixing");
    expect(view.status).toBe("conflicts with main on PR #21");
  });

  it("a worker awaiting a review decision is in_review", () => {
    const view = deriveState(
      session("worker", { issueNumber: 12, prNumber: 21 }),
      { ...facts, pr: { ciStatus: "ok", reviewDecision: "REVIEW_REQUESTED", mergeable: "MERGEABLE", approvedAtHead: false } },
    );
    expect(view.state).toBe("in_review");
    expect(view.status).toBe("awaiting review on PR #21");
  });

  it("requested changes are addressing", () => {
    const view = deriveState(
      session("worker", { issueNumber: 12, prNumber: 21 }),
      { ...facts, pr: { ciStatus: "ok", reviewDecision: "CHANGES_REQUESTED", mergeable: "MERGEABLE", approvedAtHead: false } },
    );
    expect(view.state).toBe("addressing");
    expect(view.status).toBe("addressing review on PR #21");
  });

  it("approved and green is ready — only with the head-matched approval", () => {
    const view = deriveState(
      session("worker", { issueNumber: 12, prNumber: 21 }),
      { ...facts, pr: { ciStatus: "ok", reviewDecision: "APPROVED", mergeable: "MERGEABLE", approvedAtHead: true } },
    );
    expect(view.state).toBe("ready");
    expect(view.status).toBe("approved and green, PR #21");
  });

  it("a stale approval (GitHub says APPROVED, the head-matched rule does not) reads in_review", () => {
    const view = deriveState(
      session("worker", { issueNumber: 12, prNumber: 21 }),
      { ...facts, pr: { ciStatus: "ok", reviewDecision: "APPROVED", mergeable: "MERGEABLE", approvedAtHead: false } },
    );
    expect(view.state).toBe("in_review");
    expect(view.status).toBe("awaiting review on PR #21");
  });

  it("open blockers block, exhausting fix attempts blocks too", () => {
    const blocked = deriveState(session("worker", { issueNumber: 12 }), {
      ...facts,
      issueBlocked: true,
    });
    expect(blocked.state).toBe("blocked");
    expect(blocked.status).toBe("blocked on #12");

    const exhausted = deriveState(session("worker", { issueNumber: 12 }), {
      ...facts,
      fixAttemptsExhausted: true,
    });
    expect(exhausted.state).toBe("blocked");
    expect(exhausted.status).toBe("fix attempts exhausted on #12");
  });

  it("statuses stay on one line", () => {
    for (const persona of ["worker", "reviewer", "orchestrator", "global"] as const) {
      const view = deriveState(session(persona, { issueNumber: 12, prNumber: 21 }), facts);
      expect(view.status).not.toMatch(/[\r\n]/);
    }
  });

  it("reviewer rows read in_review; approved-and-idle reads awaiting merge", () => {
    expect(deriveState(session("reviewer", { prNumber: 21 }), facts)).toEqual({
      state: "in_review",
      status: "reviewing PR #21",
    });
    expect(
      deriveState(session("reviewer", { prNumber: 21 }), {
        ...facts,
        pr: { ciStatus: "ok", reviewDecision: "APPROVED", mergeable: "MERGEABLE", approvedAtHead: false },
      }),
    ).toEqual({ state: "in_review", status: "approved PR #21, awaiting merge" });
    expect(deriveState(session("orchestrator"), facts)).toEqual({ state: null, status: "orchestrator" });
    expect(deriveState(session("global"), facts)).toEqual({ state: null, status: "global agent" });
  });

  it("the baton decides who the PR is waiting on", () => {
    // The reviewer holds it: the worker reads in review, even while a stale
    // changes-requested decision or failing CI lingers from the last round.
    const reviewerHolds = deriveState(
      session("worker", { issueNumber: 12, prNumber: 21 }),
      {
        ...facts,
        pr: { ciStatus: "ok", reviewDecision: "CHANGES_REQUESTED", mergeable: "MERGEABLE", approvedAtHead: false },
        batonHolder: "reviewer",
      },
    );
    expect(reviewerHolds.state).toBe("in_review");
    expect(reviewerHolds.status).toBe("awaiting review on PR #21");

    // The worker holds it: the reviewer's row reads awaiting author.
    expect(
      deriveState(session("reviewer", { prNumber: 21 }), {
        ...facts,
        pr: { ciStatus: "ok", reviewDecision: "CHANGES_REQUESTED", mergeable: "MERGEABLE", approvedAtHead: false },
        batonHolder: "worker",
      }),
    ).toEqual({ state: "in_review", status: "awaiting author on PR #21" });

    // The worker holding the baton reads addressing on its own row.
    const workerHolds = deriveState(
      session("worker", { issueNumber: 12, prNumber: 21 }),
      {
        ...facts,
        pr: { ciStatus: "ok", reviewDecision: "CHANGES_REQUESTED", mergeable: "MERGEABLE", approvedAtHead: false },
        batonHolder: "worker",
      },
    );
    expect(workerHolds.state).toBe("addressing");
    expect(workerHolds.status).toBe("addressing review on PR #21");

    // No baton keeps the previous ladder: failing CI is fixing.
    expect(
      deriveState(session("worker", { issueNumber: 12, prNumber: 21 }), {
        ...facts,
        pr: { ciStatus: "failed", reviewDecision: null, mergeable: "MERGEABLE", approvedAtHead: false },
      }).state,
    ).toBe("fixing");
  });
});
