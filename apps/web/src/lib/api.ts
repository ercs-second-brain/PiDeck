/**
 * Typed REST access to the daemon, driven by the shared endpoint map
 * (`@pideck/shared/src/rest.ts`). Same-origin: the daemon serves both
 * the webapp build and the API, so no base URL is needed.
 *
 * Every response is validated against the shared zod response schema, and
 * every request goes through `formatPath` — the webapp cannot drift from
 * the contract without a runtime error.
 */

import { z } from "zod";
import {
  endpoints,
  formatPath,
  ghAuthSchema,
  onboardingStateSchema,
  piAuthSchema,
  sessionSchema,
  type AgentAssets,
  type AgentSkill,
  type EndpointName,
  type EndpointParams,
  type EndpointRequest,
  type EndpointResponse,
  type OnboardingState,
  type Persona,
  type PiAuth,
  type PromptOverride,
  type RegisterProjectRequest,
  type Session,
  type SpawnAgentRequest,
  type UpdateProjectRequest,
  type UpdateSettingsRequest,
} from "@pideck/shared";

import { shareInFlight, type InFlight } from "./in-flight";

/** HTTP failure from the daemon (4xx/5xx), with context for the UI. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    detail: string,
  ) {
    super(`${method} ${path} failed: ${status} ${detail}`);
    this.name = "ApiError";
  }
}

/**
 * In-flight coalescing for GETs (issue #88): concurrent identical requests
 * share one network call, so mount effects, poll ticks, and websocket-event
 * refetches can never stack duplicate pending requests. Writes are never
 * shared — every POST goes out.
 */
const inflightGets: InFlight<unknown> = new Map();

/**
 * Shared send+parse core for one daemon call: one fetch, `ApiError` with the
 * daemon's `error` detail on !ok, zod-parse (204 → undefined) on success.
 * Used by the endpoint-map {@link request} wrapper and directly by the
 * non-endpoint-map daemon routes (e.g. the gh/pi-auth probes).
 */
async function sendAndParse<T>(path: string, method: string, init: RequestInit, response: z.ZodType): Promise<T> {
  const res = await fetch(path, { ...init, method });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const payload = (await res.json()) as { error?: string };
      if (typeof payload.error === "string") detail = payload.error;
    } catch {
      /* non-JSON error body — keep statusText */
    }
    throw new ApiError(res.status, method, path, detail);
  }
  if (res.status === 204) return undefined as T;
  return response.parse(await res.json()) as T;
}

async function request<N extends EndpointName>(
  name: N,
  params: EndpointParams<N>,
  body?: EndpointRequest<N>,
  /** Raw query string appended to the path (no leading `?`), e.g. `refresh=1`. */
  query?: string,
): Promise<EndpointResponse<N>> {
  const endpoint = endpoints[name];
  const path = formatPath(name, params) + (query === undefined ? "" : `?${query}`);
  const send = async (): Promise<EndpointResponse<N>> =>
    sendAndParse(path, endpoint.method, {
      headers:
        body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, endpoint.response) as Promise<EndpointResponse<N>>;
  // Coalesce concurrent identical GETs (#88); writes always go out.
  if (endpoint.method !== "GET") return send();
  return shareInFlight(inflightGets as InFlight<EndpointResponse<N>>, path, send);
}

// --- Projects ---------------------------------------------------------------

const LIST_PROJECTS_PATH = formatPath("listProjects", {});

export const apiListProjects = (): Promise<EndpointResponse<"listProjects">> => request("listProjects", {});

export const apiRegisterProject = async (
  body: RegisterProjectRequest,
): Promise<EndpointResponse<"registerProject">> => {
  const project = await request("registerProject", {}, body);
  // Issue #203: drop any in-flight projects-list GET that started before this
  // POST completed — a reader joining it (sidebar reload, store refresh)
  // would see the pre-registration list. The entry is normally dropped when
  // it settles; deleting it here just makes the *next* read start fresh, so
  // the #88 single-flight coalescing itself is untouched.
  inflightGets.delete(LIST_PROJECTS_PATH);
  return project;
};

export const apiUpdateProject = (
  projectId: string,
  body: UpdateProjectRequest,
): Promise<EndpointResponse<"updateProject">> => request("updateProject", { projectId }, body);

/**
 * Deletes a project locally (issue #172): daemon-side teardown of watching,
 * tmux sessions, local state, and registration — the GitHub repo is kept.
 * Rejects with `ApiError` (409) while workers are driving a PR.
 */
export const apiDeleteProject = (projectId: string): Promise<EndpointResponse<"deleteProject">> =>
  request("deleteProject", { projectId });

// --- Kanban / workers / PRs ---------------------------------------------------

export const apiGetKanban = (projectId: string): Promise<EndpointResponse<"getProjectKanban">> =>
  request("getProjectKanban", { projectId });

export const apiListWorkers = (projectId: string): Promise<EndpointResponse<"listProjectWorkers">> =>
  request("listProjectWorkers", { projectId });

export const apiListPullRequests = (projectId: string): Promise<EndpointResponse<"listProjectPullRequests">> =>
  request("listProjectPullRequests", { projectId });

export const apiGetPullRequestDiff = (
  projectId: string,
  prNumber: number,
): Promise<EndpointResponse<"getPullRequestDiff">> => request("getPullRequestDiff", { projectId, prNumber });

/** Per-worker files-changed (issue #126): PR files, or branch vs default branch. */
export const apiGetWorkerFilesChanged = (workerId: string): Promise<EndpointResponse<"getWorkerFilesChanged">> =>
  request("getWorkerFilesChanged", { workerId });

// --- Daemon-wide settings (issue #106) ----------------------------------------

export const apiGetSettings = (): Promise<EndpointResponse<"getSettings">> => request("getSettings", {});

export const apiUpdateSettings = (body: UpdateSettingsRequest): Promise<EndpointResponse<"updateSettings">> =>
  request("updateSettings", {}, body);

// --- Self-update (issues #55, #76) ----------------------------------------------

/**
 * Self-update status (issues #55, #76, #82): the daemon serves a cached gh
 * check (~5 min TTL); `refresh` bypasses it — the banner uses that on page
 * load / window focus so new updates show up immediately.
 */
export const apiGetUpdateStatus = (refresh = false): Promise<EndpointResponse<"getUpdateStatus">> =>
  request("getUpdateStatus", {}, undefined, refresh ? "refresh=1" : undefined);

/** Click-to-update (issue #76): the daemon gates on active workers (409 on
 * conflict), spawns the update shim detached and returns immediately — the
 * daemon restarts mid-apply, so the caller polls `apiGetUpdateStatus` after. */
export const apiApplyUpdate = (): Promise<EndpointResponse<"applyUpdate">> => request("applyUpdate", {});

/** Repos accessible via the daemon's gh auth — the onboarding selector (issue #217). */
export const apiListAccessibleRepos = (): Promise<EndpointResponse<"listAccessibleRepos">> =>
  request("listAccessibleRepos", {});

// --- Terminals page (sidebar + panes) -----------------------------------------

export const fetchProjects = (): Promise<EndpointResponse<"listProjects">> => request("listProjects", {});

export const fetchSessions = (projectId: string): Promise<EndpointResponse<"listProjectSessions">> =>
  request("listProjectSessions", { projectId });

/**
 * Every session daemon-wide, including the workspace-level global agent's
 * (projectId `global`) — the sidebar's global-agent row and its start
 * affordance are backed by this list plus `startGlobalAgent`.
 */
export const fetchAllSessions = (): Promise<EndpointResponse<"listAllSessions">> => request("listAllSessions", {});

export const fetchWorkers = (projectId: string): Promise<EndpointResponse<"listProjectWorkers">> =>
  request("listProjectWorkers", { projectId });

/**
 * Starts (or attaches to) a project's orchestrator session (issue #53):
 * daemon-side idempotent via `SessionManager.ensureOrchestrator`.
 */
export const startOrchestrator = (projectId: string): Promise<EndpointResponse<"ensureProjectOrchestrator">> =>
  request("ensureProjectOrchestrator", { projectId });

/**
 * Starts (or attaches to) the workspace-level global agent — the top of the
 * agent hierarchy (global agent → project orchestrators → workers → review
 * agents). Daemon-side idempotent via `POST /api/global-agent`.
 */
export const startGlobalAgent = (): Promise<EndpointResponse<"ensureGlobalAgent">> =>
  request("ensureGlobalAgent", {});

/**
 * Terminates a worker (issue #64): the daemon kills its tmux session (which
 * ends the pi process) and archives the worker record; history is kept.
 */
export const terminateWorker = (workerId: string): Promise<EndpointResponse<"terminateWorker">> =>
  request("terminateWorker", { workerId });

/**
 * Spawns a preset-prompt agent-kind session (docs/agent-kinds.md, issues
 * #297/#300/#302): the researcher carries its `question`, the audit
 * kinds take none. The `name` is the sidebar label (≤ 20 chars); the
 * daemon resolves the parent session (the project orchestrator for
 * menu spawns) and routes the report per the kind's registry spec.
 */
export const apiSpawnAgent = (projectId: string, body: SpawnAgentRequest): Promise<EndpointResponse<"spawnProjectAgent">> =>
  request("spawnProjectAgent", { projectId }, body);

/**
 * Terminates an agent-kind session (issue #311): the daemon kills the pane
 * and removes the session record (the existing `SessionManager.killSession`
 * semantics — agent sessions keep no archived log; a delivered report stays
 * where it was sent). `POST /api/sessions/:sessionId/terminate` is a
 * shape-contracted route (like `/api/gh-auth`, issue #317): the daemon
 * mounts it outside the `endpoints` map (`session-terminate.ts`), and the
 * webapp parses the body with `sessionSchema`. Worker-backed session ids
 * route through the #64 archive path; agent-kind sessions go through the
 * `SessionManager.killSession` path (pane + registry entry removed, no
 * archived log).
 */
export function apiTerminateAgentSession(sessionId: string): Promise<Session> {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/terminate`;
  return sendAndParse(path, "POST", { headers: { accept: "application/json" } }, sessionSchema);
}

/**
 * Relaunches a dead session's tmux pane (issue #117): the daemon kills any
 * lingering tmux session of the name and re-runs the session's launch path;
 * the registry record (identity/history) is preserved, only the pane is new.
 */
export const relaunchSession = (sessionId: string): Promise<EndpointResponse<"relaunchSession">> =>
  request("relaunchSession", { sessionId });

/**
 * Fetches an archived worker's log (issue #104): the scrollback captured at
 * termination plus the worker's final metadata.
 */
export const fetchArchivedWorkerLog = (workerId: string): Promise<EndpointResponse<"getArchivedWorkerLog">> =>
  request("getArchivedWorkerLog", { workerId });

// --- Per-persona agent assets (issue #315) -------------------------------------

export const apiGetAgentAssets = (): Promise<EndpointResponse<"getAgentAssets">> => request("getAgentAssets", {});

export const apiSavePromptOverride = (
  persona: Persona,
  content: string,
): Promise<EndpointResponse<"savePromptOverride">> => request("savePromptOverride", { persona }, { content });

export const apiDeletePromptOverride = (persona: Persona): Promise<EndpointResponse<"deletePromptOverride">> =>
  request("deletePromptOverride", { persona });

export const apiSaveAgentSkill = (
  skillId: string,
  body: { content: string; personas: Persona[] },
): Promise<EndpointResponse<"saveAgentSkill">> => request("saveAgentSkill", { skillId }, body);

export const apiDeleteAgentSkill = (skillId: string): Promise<EndpointResponse<"deleteAgentSkill">> =>
  request("deleteAgentSkill", { skillId });

export type { AgentAssets, AgentSkill, Persona, PromptOverride };

// --- gh auth probe (onboarding wizard step 2) --------------------------------
//
// `GET /api/gh-auth` is a non-contract daemon route (like `/api/status`):
// a capability probe over the daemon's gh CLI, not a resource API, so it
// has no entry in the shared endpoint map. The shape is contracted in the
// shared package (`ghAuthSchema`).

export type GhAuth = z.infer<typeof ghAuthSchema>;
export type { PiAuth };

export async function apiGetGhAuth(): Promise<GhAuth> {
  const response = await fetch("/api/gh-auth", { headers: { accept: "application/json" } });
  if (!response.ok) throw new ApiError(response.status, "GET", "/api/gh-auth", response.statusText);
  return ghAuthSchema.parse(await response.json());
}

// --- pi auth probe (onboarding wizard + settings banner, issue #57) ----------
//
// `GET /api/pi-auth` mirrors `/api/gh-auth`: a non-contract daemon route
// whose *shape* is contracted in the shared package (`piAuthSchema`), so
// webapp and daemon cannot drift.

export async function apiGetPiAuth(): Promise<PiAuth> {
  const response = await fetch("/api/pi-auth", { headers: { accept: "application/json" } });
  if (!response.ok) throw new ApiError(response.status, "GET", "/api/pi-auth", response.statusText);
  return piAuthSchema.parse(await response.json());
}

// --- onboarding state (wizard, issue #165) -----------------------------------
//
// `GET /api/onboarding` is the one shared source of truth for onboarding
// state: the installer's recorded results plus the live pi/gh probes, so
// the wizard marks steps the shell onboarding completed as done.

export async function apiGetOnboardingState(): Promise<OnboardingState> {
  const response = await fetch("/api/onboarding", { headers: { accept: "application/json" } });
  if (!response.ok) throw new ApiError(response.status, "GET", "/api/onboarding", response.statusText);
  return onboardingStateSchema.parse(await response.json());
}

export type { OnboardingState };

/** Error message extraction shared by all callers. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
