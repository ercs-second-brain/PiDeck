/**
 * Review-agent spawn path (issue #107): wraps `SessionManager.spawnWorker`
 * with the reviewer kind/parent linkage (`Worker.kind: "reviewer"` nested
 * under the PR-authoring worker via `parentWorkerId`), the
 * `worker.spawned` hub announcement, and the issue #56 prompt-readiness
 * parity — the review prompt is typed into the pane only when pi auth is
 * ready, else held on the {@link PromptGate} so an unauthenticated spawn
 * never swallows it.
 *
 * Kept out of the wiring constructor so the spawn flow stays a small,
 * independently testable unit.
 */

import type { Worker } from "@pideck/shared";

import type { PromptGate } from "../../agent/prompt-gate.js";
import type { SessionManager } from "../../sessions/manager.js";

export interface ReviewSpawnRequest {
  /** The PR the reviewer will review. */
  prNumber: number;
  /** The PR-authoring worker (nesting), or `null` for a sibling spawn. */
  parentWorkerId: string | null;
  /** The single-line review prompt typed into the reviewer's pane. */
  prompt: string;
}

export interface ReviewSpawnDeps {
  sessions: SessionManager;
  /** Announces the spawned reviewer on the WS hub (workers/kanban UI). */
  broadcastSpawned: (worker: Worker) => void;
  /**
   * Review account token (issue #407): when set, the reviewer pane is
   * started with `GH_TOKEN` pointing at the second GitHub account, so its
   * `gh pr review` calls file real reviews as that account instead of the
   * PR author's primary identity (which cannot review its own PR). `null`/
   * `undefined` = single-account mode — the review flow does not run at all
   * (the pipeline gates it), so the value never matters in practice.
   */
  reviewGhToken?: string | null;
  /** Pi auth readiness probe; absent = assume ready (tests/legacy hosts). */
  piReady?: () => Promise<boolean>;
  /** Holds the prompt until pi auth becomes ready (issue #56 parity). */
  promptGate?: Pick<PromptGate, "queue">;
  onError: (err: unknown) => void;
}

/**
 * Spawns one review agent for `projectId`. Returns the reviewer's worker
 * record, or `null` when the spawn failed (the error is reported through
 * `deps.onError`; the pipeline retries on a later poll).
 */
export async function spawnReviewAgent(projectId: string, request: ReviewSpawnRequest, deps: ReviewSpawnDeps): Promise<Worker | null> {
  try {
    const { worker } = await deps.sessions.spawnWorker(projectId, {
      issueNumber: 0,
      kind: "reviewer",
      prNumber: request.prNumber,
      parentWorkerId: request.parentWorkerId,
      prompt: request.prompt,
      statusMessage: "review agent launching",
      ...(deps.reviewGhToken ? { env: { GH_TOKEN: deps.reviewGhToken } } : {}),
    });
    deps.broadcastSpawned(worker);
    const ready = deps.piReady === undefined ? true : await deps.piReady();
    if (!ready && deps.promptGate !== undefined) {
      deps.promptGate.queue(worker, request.prompt);
      return worker;
    }
    // Issue #318: wait for pi to accept input before typing (the pane was
    // just created; typing inside pi's startup window swallows the submit
    // Enter). Readiness wait + submit confirmation — bare-Enter nudges
    // only, never a re-typed text.
    await deps.sessions.deliverPromptWhenReady(worker.sessionId, request.prompt);
    deps.sessions.updateWorkerStatus(worker.id, "running", "review agent running; prompt delivered");
    return worker;
  } catch (err) {
    deps.onError(err);
    return null;
  }
}
