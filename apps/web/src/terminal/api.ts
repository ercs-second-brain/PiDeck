/**
 * Typed REST access to the daemon, driven by the shared endpoint map
 * (`@agentskiss/shared`). Same-origin: the daemon serves the webapp and the
 * API together (standalone harness now, full daemon HTTP server later).
 */

import { z } from "zod";
import {
  formatPath,
  projectSchema,
  sessionSchema,
  workerSchema,
  type Project,
  type Session,
  type Worker,
} from "@agentskiss/shared";

async function get<T>(schema: z.ZodType<T>, path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${response.statusText}`);
  }
  return schema.parse(await response.json());
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
