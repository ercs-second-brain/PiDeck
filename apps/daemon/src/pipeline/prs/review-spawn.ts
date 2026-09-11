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

import { deliverSpawnPrompt, type PromptGate } from "../../agent/prompt-gate.js";
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
  /** Pi auth readiness probe (issue #424 F8: required — production wiring always provides it). */
  piReady: () => Promise<boolean>;
  /** Holds the prompt until pi auth becomes ready (issue #56 parity). */
  promptGate: Pick<PromptGate, "queue">;
  onError: (err: unknown) => void;
}

/**
 * Spawns one review agent for `projectId`. Returns the reviewer's worker
 * record, or `null` when the spawn failed (the error is reported through
 * `deps.onError`; the pipeline retries on a later poll).
 */
export async function spawnReviewAgent(projectId: string, request: ReviewSpawnRequest, deps: ReviewSpawnDeps): Promise<Worker | null> {
  // Hoisted so the delivery-failure catch below can reach the record: the
  // spawn itself succeeding is what creates the phantom.
  let worker: Worker | null = null;
  try {
    const spawned = await deps.sessions.spawnWorker(projectId, {
      issueNumber: 0,
      kind: "reviewer",
      prNumber: request.prNumber,
      parentWorkerId: request.parentWorkerId,
      prompt: request.prompt,
      statusMessage: "review agent launching",
      ...(deps.reviewGhToken ? { env: { GH_TOKEN: deps.reviewGhToken } } : {}),
    });
    worker = spawned.worker;
    deps.broadcastSpawned(worker);
    // Issue #56/#318 gated delivery — the ONE shared spawn-path dance
    // ({@link deliverSpawnPrompt}, issues #56/#318/#378; consolidated from
    // four drifted copies in issue #426): pi-auth probe → queue on the
    // gate when unready (never type a prompt into an agent that cannot
    // run), else the #318 readiness wait + exactly-once type + submit
    // confirmation; a pane that never readies is queued for a retry. A
    // delivery error propagates to the catch below (the spawn reports
    // failed through `deps.onError`; the pipeline retries on a later poll).
    await deliverSpawnPrompt(
      deps.sessions,
      deps.promptGate,
      deps.piReady,
      { kind: "worker", worker },
      request.prompt,
    );
    return worker;
  } catch (err) {
    // Issue #501 (B9): the record already says `running` (spawnWorker's
    // post-launch write) but its prompt was never delivered — this reviewer
    // will never review, and nothing else settles it (no tracker linkage,
    // the stall sweep excludes reviewers). Mark it `failed` per the prompt
    // gate's own delivery-failure convention (a prompt is never silently
    // lost, prompt-gate onDeliveryFailed) so the sidebar stops showing a
    // phantom working reviewer; the pipeline's retry spawns a replacement.
    if (worker !== null) {
      try {
        deps.sessions.updateWorkerStatus(
          worker.id,
          "failed",
          `initial prompt delivery failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        // The record may have vanished between the spawn and the failure.
      }
    }
    deps.onError(err);
    return null;
  }
}
