/**
 * Typed REST API surface between the webapp and the daemon.
 *
 * `endpoints` is the documented endpoint map: every route carries its HTTP
 * method, path template (`:name` segments), and zod schemas for path params,
 * request body, and response body. Request/response types are derived from
 * the map, so schemas cannot drift from the types.
 *
 * Endpoints: projects CRUD/register, per-project kanban state, sessions and
 * workers lists, per-project orchestrator start (issue #53), PR diffs, and
 * daemon settings (auto-agent username, concurrency).
 */

import { z } from "zod";
import {
  kanbanBoardSchema,
  projectSchema,
  projectSettingsSchema,
  pullRequestSchema,
  sessionSchema,
  workerSchema,
  type PullRequest,
} from "./domain.js";

export const HTTP_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

// ---------------------------------------------------------------------------
// Request / response bodies
// ---------------------------------------------------------------------------

/** Register (clone) or create a GitHub repo as a new project. */
export const registerProjectRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("clone"),
    repoUrl: z.url(),
    name: z.string().min(1).optional(),
    defaultBranch: z.string().min(1).optional(),
    settings: projectSettingsSchema.partial().optional(),
  }),
  z.object({
    mode: z.literal("create"),
    name: z.string().min(1),
    /** Created repos default to private (PRD). */
    isPrivate: z.boolean().default(true),
    defaultBranch: z.string().min(1).optional(),
    settings: projectSettingsSchema.partial().optional(),
  }),
]);
export type RegisterProjectRequest = z.infer<typeof registerProjectRequestSchema>;

/** Partial project update: rename, change default branch, or tweak settings. */
export const updateProjectRequestSchema = z.object({
  name: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).optional(),
  settings: projectSettingsSchema.partial().optional(),
});
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

/** Daemon-wide settings. */
export const settingsSchema = z.object({
  /** Default auto-agent username applied to new projects; `null` disables auto-spawn by default. */
  autoAgentUsername: z.string().min(1).nullable(),
  /** Default worker concurrency applied to new projects. */
  defaultWorkerConcurrency: z.number().int().min(1).max(16),
});
export type Settings = z.infer<typeof settingsSchema>;

export const updateSettingsRequestSchema = settingsSchema.partial();
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;

/** A single file within a PR diff. */
export const diffFileSchema = z.object({
  filename: z.string().min(1),
  status: z.enum(["added", "modified", "removed", "renamed"]),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
});
export type DiffFile = z.infer<typeof diffFileSchema>;

/** Readable diff of a PR for the webapp's diff-review view. */
export const pullRequestDiffSchema = z.object({
  projectId: z.string().min(1),
  prNumber: z.number().int().positive(),
  headBranch: z.string().min(1),
  baseBranch: z.string().min(1),
  files: z.array(diffFileSchema),
  /** Unified diff of the whole PR. */
  patch: z.string(),
});
export type PullRequestDiff = z.infer<typeof pullRequestDiffSchema>;

/** PR summary for lists/views; diff bodies are fetched separately. */
export const pullRequestSummarySchema = pullRequestSchema;
export type PullRequestSummary = PullRequest;

/**
 * Result of a self-update check (issue #55): the daemon's local source
 * revision (`git rev-parse HEAD` at `$AK_HOME/src`) compared against the
 * upstream repo/ref via `gh api repos/:owner/:repo/commits/<ref>` — the same
 * repo/ref the installer used (see install/lib/source.sh), so private repos
 * and dev refs check like public ones.
 */
export const updateStatusSchema = z.object({
  /** Upstream repository as `owner/name` (or the configured URL when it has no GitHub slug). */
  repo: z.string().min(1),
  /** Upstream ref (branch/tag) the installer tracks; usually `main`. */
  ref: z.string().min(1),
  /** Full SHA of the local source checkout; `null` when missing/not a git repo. */
  localSha: z.string().min(1).nullable(),
  /** Full SHA of the upstream ref head; `null` when the check failed. */
  remoteSha: z.string().min(1).nullable(),
  /** `true` only when both revisions resolved and differ (→ `agentskiss update`). */
  updateAvailable: z.boolean(),
  /** When the check ran (ISO timestamp). */
  checkedAt: z.iso.datetime(),
  /** Human-readable failure detail (`null` when the check succeeded). */
  error: z.string().nullable(),
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

// ---------------------------------------------------------------------------
// Endpoint map
// ---------------------------------------------------------------------------

/**
 * Every REST route. `request: null` means the endpoint takes no request body
 * (e.g. GET/DELETE); `response` is always a zod schema validating the body
 * the daemon returns.
 */
export const endpoints = {
  // Projects
  listProjects: {
    method: "GET",
    path: "/api/projects",
    params: z.object({}),
    request: null,
    response: z.array(projectSchema),
  },
  registerProject: {
    method: "POST",
    path: "/api/projects",
    params: z.object({}),
    request: registerProjectRequestSchema,
    response: projectSchema,
  },
  getProject: {
    method: "GET",
    path: "/api/projects/:projectId",
    params: z.object({ projectId: z.string().min(1) }),
    request: null,
    response: projectSchema,
  },
  updateProject: {
    method: "PATCH",
    path: "/api/projects/:projectId",
    params: z.object({ projectId: z.string().min(1) }),
    request: updateProjectRequestSchema,
    response: projectSchema,
  },
  deleteProject: {
    method: "DELETE",
    path: "/api/projects/:projectId",
    params: z.object({ projectId: z.string().min(1) }),
    request: null,
    /** 204 No Content. */
    response: z.undefined(),
  },

  // Kanban
  getProjectKanban: {
    method: "GET",
    path: "/api/projects/:projectId/kanban",
    params: z.object({ projectId: z.string().min(1) }),
    request: null,
    response: kanbanBoardSchema,
  },

  // Sessions & workers
  listProjectSessions: {
    method: "GET",
    path: "/api/projects/:projectId/sessions",
    params: z.object({ projectId: z.string().min(1) }),
    request: null,
    response: z.array(sessionSchema),
  },
  listProjectWorkers: {
    method: "GET",
    path: "/api/projects/:projectId/workers",
    params: z.object({ projectId: z.string().min(1) }),
    request: null,
    response: z.array(workerSchema),
  },

  /**
   * Start (or attach to the existing) per-project orchestrator session
   * (issue #53): wraps `SessionManager.ensureOrchestrator` — idempotent, so
   * the daemon returns the live orchestrator session when one exists.
   */
  ensureProjectOrchestrator: {
    method: "POST",
    path: "/api/projects/:projectId/orchestrator",
    params: z.object({ projectId: z.string().min(1) }),
    request: null,
    response: sessionSchema,
  },

  // Pull requests
  listProjectPullRequests: {
    method: "GET",
    path: "/api/projects/:projectId/pulls",
    params: z.object({ projectId: z.string().min(1) }),
    request: null,
    response: z.array(pullRequestSummarySchema),
  },
  getPullRequestDiff: {
    method: "GET",
    path: "/api/projects/:projectId/pulls/:prNumber/diff",
    params: z.object({ projectId: z.string().min(1), prNumber: z.number().int().positive() }),
    request: null,
    response: pullRequestDiffSchema,
  },

  // Self-update (issue #55)
  getUpdateStatus: {
    method: "GET",
    path: "/api/update",
    params: z.object({}),
    request: null,
    response: updateStatusSchema,
  },

  // Settings
  getSettings: {
    method: "GET",
    path: "/api/settings",
    params: z.object({}),
    request: null,
    response: settingsSchema,
  },
  updateSettings: {
    method: "PUT",
    path: "/api/settings",
    params: z.object({}),
    request: updateSettingsRequestSchema,
    response: settingsSchema,
  },
} as const satisfies Record<string, EndpointShape>;

/** Structural constraint every entry of `endpoints` must satisfy. */
export interface EndpointShape {
  method: HttpMethod;
  /** Path template; `:name` segments correspond to keys of `params`. */
  path: string;
  params: z.ZodType;
  request: z.ZodType | null;
  response: z.ZodType;
}

export type EndpointName = keyof typeof endpoints;

/** Path parameters for an endpoint, inferred from its `params` schema. */
export type EndpointParams<N extends EndpointName> = z.output<(typeof endpoints)[N]["params"]>;

/** Request body for an endpoint (`undefined` when `request` is `null`). */
export type EndpointRequest<N extends EndpointName> =
  (typeof endpoints)[N]["request"] extends null ? undefined : z.output<NonNullable<(typeof endpoints)[N]["request"]>>;

/** Response body for an endpoint, inferred from its `response` schema. */
export type EndpointResponse<N extends EndpointName> = z.output<(typeof endpoints)[N]["response"]>;

/**
 * Expand a path template (`/api/projects/:projectId`) with concrete param
 * values. Values are `encodeURIComponent`-ed; numeric params are stringified.
 */
export function formatPath<N extends EndpointName>(name: N, params: EndpointParams<N>): string {
  const template = endpoints[name].path;
  return template.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => {
    const value = (params as Record<string, unknown>)[key];
    if (value === undefined) {
      throw new Error(`Missing path param "${key}" for endpoint "${String(name)}"`);
    }
    return encodeURIComponent(String(value));
  });
}
