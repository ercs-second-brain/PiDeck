/**
 * Project worker-concurrency occupancy (issue #393, KISS-audit F2): ONE
 * predicate for "how many concurrency slots does this project occupy" —
 * the project's active workers plus its live workerLike agent-kind
 * sessions (docs/agent-kinds.md §5: worker-like kinds occupy a real
 * workspace like workers; cheap kinds are exempt).
 *
 * Every spawn path that gates a spawn on the project's
 * `workerConcurrency` cap — the CLI worker spawn, the agent-kind spawn,
 * and the auto review-agent spawn — must count occupants through this
 * module, so a project at its cap of workerLike kind sessions rejects
 * worker spawns (and vice versa) on every path. The all-projects update
 * gate (`countActiveWorkers` in `api/handlers.ts`) answers a different
 * question and deliberately does NOT use this module.
 */

import { ACTIVE_WORKER_STATUSES, type AgentKind, type Session, type Worker } from "@pideck/shared";

import type { AgentKindLookup } from "./agent-kinds.js";

/** The slice of the session facade occupancy reads (SessionManager satisfies it). */
export interface OccupancySessions {
  listWorkers(filter?: { projectId?: string }): Worker[];
  /** Live sessions only — archived persona agents never occupy a slot. */
  listSessions(projectId?: string): Session[];
}

export interface ProjectOccupancyInput {
  /** The project's worker records (any status). */
  workers: Worker[];
  /** The project's live sessions (archived ones already excluded). */
  sessions: Session[];
  /** Whether an agent kind occupies a concurrency slot (spec v2 `workerLike`). */
  isWorkerLikeKind: (kind: AgentKind) => boolean;
}

/** Pure core over already-read records — tests and fakes project their own inputs. */
export function countProjectOccupancy({ workers, sessions, isWorkerLikeKind }: ProjectOccupancyInput): number {
  const activeWorkers = workers.filter((worker) => ACTIVE_WORKER_STATUSES.has(worker.status)).length;
  const workerLikeKindSessions = sessions.filter(
    (session) => session.agentKind !== undefined && isWorkerLikeKind(session.agentKind),
  ).length;
  return activeWorkers + workerLikeKindSessions;
}

/**
 * The occupancy of one project, read through the session facade and the
 * agent-kind registry — the form every spawn path calls.
 */
export function countProjectOccupants(sessions: OccupancySessions, agentKinds: AgentKindLookup, projectId: string): number {
  return countProjectOccupancy({
    workers: sessions.listWorkers({ projectId }),
    sessions: sessions.listSessions(projectId),
    isWorkerLikeKind: (kind) => agentKinds.get(kind)?.workerLike === true,
  });
}
