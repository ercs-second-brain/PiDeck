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

import type { Worker } from "@agentskiss/shared";

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
    });
    deps.broadcastSpawned(worker);
    const ready = deps.piReady === undefined ? true : await deps.piReady();
    if (!ready && deps.promptGate !== undefined) {
      deps.promptGate.queue(worker, request.prompt);
      return worker;
    }
    await deps.sessions.sendKeys(worker.sessionId, request.prompt, { enter: true });
    deps.sessions.updateWorkerStatus(worker.id, "running", "review agent running; prompt delivered");
    return worker;
  } catch (err) {
    deps.onError(err);
    return null;
  }
}
