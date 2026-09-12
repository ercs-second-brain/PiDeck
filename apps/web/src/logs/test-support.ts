import type { SessionView } from "@pideck/shared";

/** A minimal SessionView for component tests; override fields per case. */
export function makeView(overrides: Partial<SessionView["session"]> = {}): SessionView {
  return {
    session: {
      id: "s1",
      persona: "worker",
      projectId: "p1",
      tmuxSession: "pideck-s1",
      spawnedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      model: null,
      lastPromptedHeadSha: null,
      lastDeliveredIssueCommentId: null,
      lastDeliveredPrCommentId: null,
      lastDeliveredReviewId: null,
      fixAttempts: 0,
      lastActivityAt: null,
      ...overrides,
    },
    state: "done",
    status: "archived",
    parentSessionId: null,
    title: null,
  };
}