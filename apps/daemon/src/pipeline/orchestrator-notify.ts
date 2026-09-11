/**
 * Deterministic orchestrator-pane notification (issue #490).
 *
 * The PR loop's `notification.pr.ready_for_merge` event (issue #408) is
 * forwarded to the WS hub for the webapp, but the owning project's
 * orchestrator is a pi session in a tmux pane — it does not see hub
 * broadcasts, so approved PRs could sit unmerged until it happened to poll.
 * The orchestrator's notification path is its pane (worker notifications
 * arrive there; `pideck send` parity), so the wiring types a message into
 * it on every ready-for-merge event.
 *
 * Delivery is deterministic: `ensureOrchestrator` guarantees a live target
 * pane exists (the daemon's start order — orchestrator bootstrap before
 * `automation.start()` — normally means it already runs the orchestrator
 * persona), and the pipeline fires the event exactly once per approved
 * round, so the pane is messaged exactly once per round too.
 */

import type { Session } from "@pideck/shared";

/** The session-manager slice the notifier needs. */
export interface OrchestratorNotifySessions {
  /** Find-or-create the project's one live orchestrator session. */
  ensureOrchestrator(projectId: string): Promise<Session>;
  /** Type text into a session's pane (the `pideck send` mechanism). */
  sendKeys(sessionId: string, keys: string, options?: { enter?: boolean }): Promise<void>;
}

/**
 * The pane message for a ready-for-merge notification: states the PR, its
 * title, and why it is actionable. Informational — merging stays
 * human/orchestrator-approved (the orchestrator persona carries the
 * do-not-merge-unless-asked rule; this message only surfaces the state).
 */
export function orchestratorReadyForMergeMessage(prNumber: number, title: string): string {
  return `[pideck] PR #${prNumber} "${title}" is CI-green and approved — ready for review and merge.`;
}

/**
 * Delivers one notification into the project's orchestrator pane. Throws on
 * failure — the caller decides how failures surface (the wiring logs them
 * through `onError`; the loop keeps running).
 */
export async function notifyOrchestrator(sessions: OrchestratorNotifySessions, projectId: string, message: string): Promise<void> {
  const orchestrator = await sessions.ensureOrchestrator(projectId);
  await sessions.sendKeys(orchestrator.id, message, { enter: true });
}