/**
 * Typed REST access to the daemon, driven by the shared endpoint map
 * (`@agentskiss/shared`). Same-origin: the daemon serves the webapp and the
 * API together (standalone harness now, full daemon HTTP server later).
 */

import { z } from "zod";
import {
  archivedWorkerLogSchema,
  formatPath,
  projectSchema,
  sessionSchema,
  workerSchema,
  type ArchivedWorkerLog,
  type Project,
  type Session,
  type Worker,
} from "@agentskiss/shared";

import { shareInFlight, type InFlight } from "../lib/in-flight";

/**
 * In-flight coalescing for the sidebar's GETs (issue #88): concurrent
 * identical requests share one network call, so a poll tick landing while
 * the previous load is still pending joins it instead of stacking requests.
 */
const inflightGets: InFlight<unknown> = new Map();

async function get<T>(schema: z.ZodType<T>, path: string): Promise<T> {
  return shareInFlight(inflightGets as InFlight<T>, path, async () => {
    const response = await fetch(path, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`GET ${path} failed: ${response.status} ${response.statusText}`);
    }
    return schema.parse(await response.json());
  });
}

/** POST with no body (contract endpoints with `request: null`). */
async function post<T>(schema: z.ZodType<T>, path: string): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`POST ${path} failed: ${response.status} ${response.statusText}`);
  }
  return schema.parse(await response.json());
}

export function fetchProjects(): Promise<Project[]> {
  return get(z.array(projectSchema), formatPath("listProjects", {}));
}

export function fetchSessions(projectId: string): Promise<Session[]> {
  return get(z.array(sessionSchema), formatPath("listProjectSessions", { projectId }));
}

export function fetchWorkers(projectId: string): Promise<Worker[]> {
  return get(z.array(workerSchema), formatPath("listProjectWorkers", { projectId }));
}

/**
 * Starts (or attaches to) a project's orchestrator session (issue #53):
 * daemon-side idempotent via `SessionManager.ensureOrchestrator`.
 */
export function startOrchestrator(projectId: string): Promise<Session> {
  return post(sessionSchema, formatPath("ensureProjectOrchestrator", { projectId }));
}

/**
 * Terminates a worker (issue #64): the daemon kills its tmux session (which
 * ends the pi process) and archives the worker record; history is kept.
 */
export function terminateWorker(workerId: string): Promise<Worker> {
  return post(workerSchema, formatPath("terminateWorker", { workerId }));
}

/**
 * Relaunches a dead session's tmux pane (issue #117): the daemon kills any
 * lingering tmux session of the name and re-runs the session's launch path;
 * the registry record (identity/history) is preserved, only the pane is new.
 */
export function relaunchSession(sessionId: string): Promise<Session> {
  return post(sessionSchema, formatPath("relaunchSession", { sessionId }));
}

/**
 * Fetches an archived worker's log (issue #104): the scrollback captured at
 * termination plus the worker's final metadata.
 */
export function fetchArchivedWorkerLog(workerId: string): Promise<ArchivedWorkerLog> {
  return get(archivedWorkerLogSchema, formatPath("getArchivedWorkerLog", { workerId }));
}
