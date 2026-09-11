/**
 * The PR pipeline's session-control facade over the `SessionManager`
 * (issue #46 wiring), extracted from `wiring.ts` when the stall sweep's
 * assembly pushed the automation constructor past the lint budget: one
 * construction site for the broadcast-wrapping status updates, the
 * occupancy predicate, and the review-agent spawn path.
 *
 * Every status change and archival announced here lands on the WS hub as a
 * `worker.status.changed` broadcast, so open boards move live with worker
 * transitions (issues #10/#11, #106, #107).
 */

import { workerSchema } from "@pideck/shared";

import { countProjectOccupants } from "../sessions/occupancy.js";
import type { AgentKindLookup } from "../sessions/agent-kinds.js";
import type { SessionManager } from "../sessions/manager.js";
import type { PRSessionControl } from "./prs/pipeline.js";
import type { KanbanBridge } from "./broadcast.js";
import type { PromptGate } from "../agent/prompt-gate.js";
import { spawnReviewAgent as spawnReviewAgentImpl } from "./prs/review-spawn.js";

export interface BuildSessionControlOptions {
  sessions: SessionManager;
  bridge: KanbanBridge;
  /** Agent-kind registry (issue #393 occupancy predicate). */
  agentKinds: AgentKindLookup;
  /** Review account token (issue #407): reviewer panes run `gh` as the second identity. */
  reviewAccountToken: () => string | null;
  /** Pi auth readiness for the review-agent prompt gate (issue #107). */
  piReady: () => Promise<boolean>;
  /** Prompt gate holding review prompts until pi is ready (issue #56). */
  promptGate: Pick<PromptGate, "queue">;
  now: () => Date;
  onError: (err: unknown, where: string) => void;
}

/** Builds the session control the PR loop and the stall sweep drive workers through. */
export function buildPRSessionControl(options: BuildSessionControlOptions): PRSessionControl {
  const { sessions, bridge, now, onError } = options;
  return {
    listWorkers: (filter) => sessions.listWorkers(filter),
    getWorker: (workerId) => sessions.getWorker(workerId),
    updateWorkerStatus: (workerId, status, statusMessage) => {
      const worker = sessions.updateWorkerStatus(workerId, status, statusMessage);
      bridge.broadcast(
        {
          type: "worker.status.changed",
          at: now().toISOString(),
          projectId: worker.projectId,
          workerId: worker.id,
          status,
        },
        `worker-status:${workerId}`,
      );
      return worker;
    },
    sendKeys: (sessionId, keys, sendOptions) => sessions.sendKeys(sessionId, keys, sendOptions),
    // Issue #393: the review path gates the `workerConcurrency` cap with
    // the SAME occupancy predicate as the CLI/agent-kind spawn paths —
    // active workers + live workerLike kind sessions.
    countProjectOccupants: (projectId) => countProjectOccupants(sessions, options.agentKinds, projectId),
    // Issue #106: terminate-on-merge archives the owning worker (kills its
    // pane); the wiring announces the terminal status like a manual terminate.
    archiveWorker: async (workerId, message) => {
      const worker = await sessions.archiveWorker(workerId, message);
      if (worker !== null) {
        bridge.broadcast(
          {
            type: "worker.status.changed",
            at: now().toISOString(),
            projectId: worker.projectId,
            workerId: worker.id,
            status: worker.status,
          },
          `worker-status:${workerId}`,
        );
      }
      return worker;
    },
    // Issue #107: the auto review agent spawn path — reviewer kind nested
    // under the PR-authoring worker, spawn announced, prompt gated on pi
    // readiness like manual spawns (issue #56 parity).
    spawnReviewAgent: (projectId, request) =>
      spawnReviewAgentImpl(projectId, request, {
        sessions,
        reviewGhToken: options.reviewAccountToken(),
        broadcastSpawned: (worker) => {
          bridge.broadcast(
            { type: "worker.spawned", at: now().toISOString(), worker: workerSchema.parse(worker) },
            `spawn:${projectId}`,
          );
        },
        piReady: options.piReady,
        promptGate: options.promptGate,
        onError: (err) => onError(err, `review-spawn:${projectId}`),
      }),
  };
}