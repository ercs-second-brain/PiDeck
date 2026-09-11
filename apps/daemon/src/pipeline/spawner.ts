/**
 * The issue-spawn pipeline's hub-announced spawner (issue #46 wiring,
 * extracted from wiring.ts): `SessionManager`-backed spawns announced on
 * the WS hub (manual spawns announce via the spawn endpoint; the pipeline
 * bypasses it), with the issue context prompt (issue #266) gated on pi
 * readiness like manual spawns and review-agent spawns (issue #56), and —
 * issue #416 — the retract archive that announces unassigned/closed
 * issues' terminal worker statuses like a manual archive.
 */

import { workerSchema } from "@pideck/shared";

import type { PromptGate } from "../agent/prompt-gate.js";
import type { SessionManager } from "../sessions/manager.js";
import { SessionManagerSpawner, type WorkerSpawner } from "./issues/ports.js";
import type { KanbanBridge } from "./broadcast.js";

export interface HubAnnouncedSpawnerDeps {
  sessions: SessionManager;
  /** Pi auth readiness probe; absent = assume ready (tests/legacy hosts). */
  piReady?: () => Promise<boolean>;
  /** Holds the prompt until pi auth becomes ready (issue #56 parity). */
  promptGate?: Pick<PromptGate, "queue">;
}

export function hubAnnouncedSpawner(
  deps: HubAnnouncedSpawnerDeps,
  bridge: KanbanBridge,
  now: () => Date,
  onError: (err: unknown, where: string) => void,
): WorkerSpawner {
  const base = new SessionManagerSpawner(deps.sessions, {
    ...(deps.piReady !== undefined ? { piReady: deps.piReady } : {}),
    ...(deps.promptGate !== undefined ? { promptGate: deps.promptGate } : {}),
    onError: (err) => onError(err, "issue-spawn-prompt"),
  });
  return {
    spawnWorker: async (projectId, issueNumber, prompt, options) => {
      const spawned = await base.spawnWorker(projectId, issueNumber, prompt, options);
      bridge.broadcast(
        { type: "worker.spawned", at: now().toISOString(), worker: workerSchema.parse(spawned.worker) },
        `spawn:${projectId}`,
      );
      return spawned;
    },
    // Issue #471 reuse: a re-tasked worker is not a new spawn — its
    // lifecycle flip (running) announces like any status change.
    retaskWorker: async (workerId, issueNumber, prompt) => {
      const worker = await base.retaskWorker(workerId, issueNumber, prompt);
      bridge.broadcast(
        {
          type: "worker.status.changed",
          at: now().toISOString(),
          projectId: worker.projectId,
          workerId: worker.id,
          status: worker.status,
        },
        `worker-status:${worker.id}`,
      );
      return worker;
    },
    listActiveWorkerIssueNumbers: (projectId) => base.listActiveWorkerIssueNumbers(projectId),
    // Issue #416 retract: archiving an unassigned/closed issue's workers
    // announces the terminal status like a manual archive.
    archiveWorkersForIssue: async (projectId, issueNumber, message) => {
      const archived = await base.archiveWorkersForIssue(projectId, issueNumber, message);
      for (const worker of archived) {
        bridge.broadcast(
          {
            type: "worker.status.changed",
            at: now().toISOString(),
            projectId: worker.projectId,
            workerId: worker.id,
            status: worker.status,
          },
          `worker-status:${worker.id}`,
        );
      }
      return archived;
    },
  };
}
