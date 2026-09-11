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
 * Delivery is deterministic and shell-safe (issue #500): `ensureOrchestrator`
 * guarantees a live target pane exists, but a live pane is not necessarily
 * running the orchestrator persona — pi may never have bootstrapped in it
 * (crash before the bootstrap sweep, a resurrected plain shell). Typing the
 * notification there loses it to a shell error. So before typing, a pane
 * guard confirms the pane runs the agent persona and accepts input: a bare
 * pane is re-bootstrapped first (the #12 machinery), and an unrecoverable
 * pane skips the delivery loudly instead. The pipeline fires the event
 * exactly once per approved round, so a deliverable pane is messaged exactly
 * once per round too.
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
 * The pane-delivery guard (issue #500): guarantees the pane behind `session`
 * runs the agent persona and is accepting input before notification text is
 * typed into it. `null` = unrecoverable — the caller must skip delivery
 * loudly (an actionable error/log), never type into a bare shell.
 */
export interface OrchestratorPaneGuard {
  ensureReadyPane(session: Session): Promise<Session | null>;
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
 * through `onError`; the loop keeps running). A bare-shell orchestrator pane
 * (issue #500) is recovered first and otherwise skips the delivery loudly —
 * the error names the state and the recovery path, and no text is typed
 * into the shell.
 */
export async function notifyOrchestrator(sessions: OrchestratorNotifySessions, guard: OrchestratorPaneGuard, projectId: string, message: string): Promise<void> {
  const orchestrator = await sessions.ensureOrchestrator(projectId);
  // Issue #500: `ensureOrchestrator` only guarantees a live pane — without
  // the guard, a pane pi never bootstrapped in would receive the message as
  // shell input. The guard re-bootstraps a bare pane and reports it
  // undeliverable when recovery cannot produce an input-ready agent pane.
  const ready = await guard.ensureReadyPane(orchestrator);
  if (ready === null) {
    throw new Error(
      `orchestrator pane for project "${projectId}" is not bootstrapped (no input-ready agent pane after recovery) — skipping the notification instead of typing it into a bare shell; re-run the orchestrator bootstrap (the daemon start sweep) and deliver the message manually if needed`,
    );
  }
  await sessions.sendKeys(orchestrator.id, message, { enter: true });
}