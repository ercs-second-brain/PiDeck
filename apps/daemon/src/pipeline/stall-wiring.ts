/**
 * Stall-sweep wiring (issue #467, extracted so `wiring.ts` stays within
 * its line budget): the collaborators the deterministic stall backstop
 * consumes, assembled once from the daemon options.
 *
 * - {@link announceWorkerStatus} — worker status updates announced on the
 *   WS hub; shared by the PR loop's session control and the stall sweep so
 *   the broadcast never drifts.
 * - {@link buildStallSweep} — the sweep over a watched project's workers:
 *   prompt-in-flight detection reads the prompt gate, re-prompts go through
 *   the session facade's tmux sendKeys, and status updates are announced.
 */

import type { Worker } from "@pideck/shared";

import type { GithubAutomationOptions } from "./wiring.js";
import type { KanbanBridge } from "./broadcast.js";
import { StallSweep } from "./issues/stall-sweep.js";

/**
 * A worker status update that also broadcasts the shared
 * `worker.status.changed` event on the hub (the sessionControl shape).
 */
export type WorkerStatusAnnouncer = (workerId: string, status: Worker["status"], statusMessage?: string) => Worker;

/**
 * Builds the ONE status announcer both the PR loop's session control and
 * the stall sweep use: updates the registry record, then broadcasts the
 * hub event (the #106 manual-terminate announcement pattern).
 */
export function announceWorkerStatus(
  sessions: GithubAutomationOptions["sessions"],
  bridge: KanbanBridge,
  now: () => Date,
): WorkerStatusAnnouncer {
  return (workerId, status, statusMessage) => {
    const worker = sessions.updateWorkerStatus(workerId, status, statusMessage);
    bridge.broadcast(
      {
        type: "worker.status.changed",
        at: now().toISOString(),
        projectId: worker.projectId,
        workerId: worker.id,
        status,
      },
      `worker-status:${worker.id}`,
    );
    return worker;
  };
}

/**
 * Builds the stall sweep (issue #467) over the watched projects: registry
 * workers, prompt-gate in-flight detection, tmux sendKeys delivery, and
 * announced status updates. Exhaustion notifications are returned by the
 * sweep and broadcast by the wiring.
 */
export function buildStallSweep(
  options: GithubAutomationOptions,
  announceStatus: WorkerStatusAnnouncer,
  now: () => Date,
  onError: (err: unknown, where: string) => void,
): StallSweep {
  return new StallSweep({
    listWorkers: (projectId) => options.sessions.listWorkers({ projectId }),
    hasPromptInFlight: (workerId) => options.promptGate.holdsWorker(workerId),
    sendKeys: (sessionId, keys, sendOptions) => options.sessions.sendKeys(sessionId, keys, sendOptions),
    updateWorkerStatus: (workerId, status, statusMessage) => announceStatus(workerId, status, statusMessage),
    now,
    onError: (err) => onError(err, "stall-sweep"),
  });
}