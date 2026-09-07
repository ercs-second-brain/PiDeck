/**
 * Typed REST access to the daemon, driven by the shared endpoint map
 * (`@agentskiss/shared/src/rest.ts`). Same-origin: the daemon serves both
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
  piAuthSchema,
  type EndpointName,
  type EndpointParams,
  type EndpointRequest,
  type EndpointResponse,
  type PiAuth,
  type RegisterProjectRequest,
  type UpdateProjectRequest,
  type UpdateSettingsRequest,
} from "@agentskiss/shared";

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

async function request<N extends EndpointName>(
  name: N,
  params: EndpointParams<N>,
  body?: EndpointRequest<N>,
  /** Raw query string appended to the path (no leading `?`), e.g. `refresh=1`. */
  query?: string,
): Promise<EndpointResponse<N>> {
  const endpoint = endpoints[name];
  const path = formatPath(name, params) + (query === undefined ? "" : `?${query}`);
  const send = async (): Promise<EndpointResponse<N>> => {
    const response = await fetch(path, {
      method: endpoint.method,
      headers:
        body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      let detail = response.statusText;
      try {
        const payload = (await response.json()) as { error?: string };
        if (typeof payload.error === "string") detail = payload.error;
      } catch {
        /* non-JSON error body — keep statusText */
      }
      throw new ApiError(response.status, endpoint.method, path, detail);
    }
    if (response.status === 204) return undefined as EndpointResponse<N>;
    return (endpoint.response as z.ZodType).parse(await response.json()) as EndpointResponse<N>;
  };
  // Coalesce concurrent identical GETs (#88); writes always go out.
  if (endpoint.method !== "GET") return send();
  return shareInFlight(inflightGets as InFlight<EndpointResponse<N>>, path, send);
}

// --- Projects ---------------------------------------------------------------

export const apiListProjects = (): Promise<EndpointResponse<"listProjects">> => request("listProjects", {});

export const apiRegisterProject = (body: RegisterProjectRequest): Promise<EndpointResponse<"registerProject">> =>
  request("registerProject", {}, body);

export const apiUpdateProject = (
  projectId: string,
  body: UpdateProjectRequest,
): Promise<EndpointResponse<"updateProject">> => request("updateProject", { projectId }, body);

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

// --- gh auth probe (onboarding wizard step 1) --------------------------------
//
// `GET /api/gh-auth` is a non-contract daemon route (like `/api/status`):
// a capability probe over the daemon's gh CLI, not a resource API, so it
// has no entry in the shared endpoint map. Shape is validated here.

export const ghAuthSchema = z.object({
  authenticated: z.boolean(),
  login: z.string().nullable(),
  tokenSource: z.string(),
  scopes: z.array(z.string()),
  canCreateRepos: z.enum(["yes", "no", "unknown"]),
  canCreatePrivateRepos: z.enum(["yes", "no", "unknown"]),
  canCreatePublicRepos: z.enum(["yes", "no", "unknown"]),
  detail: z.string(),
});
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

/** Error message extraction shared by all callers. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
