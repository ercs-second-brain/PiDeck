/**
 * Typed REST API surface between the webapp and the daemon.
 *
 * `endpoints` is the documented endpoint map: every route carries its HTTP
 * method, path template (`:name` segments), and zod schemas for path params,
 * request body, and response body. Request/response types are derived from
 * the map, so schemas cannot drift from the types.
 *
 * Endpoints: projects CRUD/register, per-project kanban state, sessions and
 * workers lists, per-project orchestrator start (issue #53), worker
 * terminate (issue #64), PR diffs, per-worker files-changed (issue #126),
 * and daemon settings (auto-agent username, concurrency, worker-pipeline
 * toggles #106).
 */

import { z } from "zod";
import {
  archivedWorkerLogSchema,
  kanbanBoardSchema,
  projectSchema,
  projectSettingsSchema,
  pullRequestSchema,
  refNumberSchema,
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

/**
 * Daemon-wide settings (all projects; issue #106). The three worker-pipeline
 * toggles gate the PR loop's always-on behaviors and default ON: OFF means
 * the pipeline skips that step. Read fresh on every pipeline decision, so a
 * toggle takes effect without a daemon restart.
 */
export const settingsSchema = z.object({
  /** Default auto-agent username applied to new projects; `null` disables auto-spawn by default. */
  autoAgentUsername: z.string().min(1).nullable(),
  /** Default worker concurrency applied to new projects. */
  defaultWorkerConcurrency: z.number().int().min(1).max(16),
  /** Terminate (archive) a worker's pane when its PR merges. */
  terminateOnMerge: z.boolean().default(true),
  /** Let the PR loop drive workers to fix their PRs' failing CI. */
  autoFixCi: z.boolean().default(true),
  /** Let the PR loop deliver new review comments to workers for addressing. */
  autoFixReviewComments: z.boolean().default(true),
  /** Spawn an auto review agent on green, unapproved PRs (issue #107). */
  autoReview: z.boolean().default(true),
  /**
   * Browser Notification API for merged PRs (issue #111, mirrored from
   * agent-orchestrator's notification behavior). Default **off** — the
   * in-app toast always shows; this opt-in additionally fires an OS-level
   * browser notification. The webapp requests the permission when the
   * toggle is first enabled.
   */
  browserMergeNotifications: z.boolean().default(false),
});
export type Settings = z.infer<typeof settingsSchema>;

export const updateSettingsRequestSchema = settingsSchema.partial();
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;

/** GitHub repo accessible via the daemon's gh auth (issue #217): the clone URL derives verbatim from owner/name — no case transformation (#216). */
export const accessibleRepoSchema = z.object({ owner: z.string().min(1), name: z.string().min(1), isPrivate: z.boolean() }); export type AccessibleRepo = z.infer<typeof accessibleRepoSchema>;
/**
 * Response body of the daemon's pi-auth probe (`GET /api/pi-auth`, mirroring
 * `GET /api/gh-auth`): which pi providers have ready credentials and which
 * model pi would start with. Deliberately **not** an entry in the
 * `endpoints` map — like gh-auth it is a daemon-side capability probe, not
 * a resource API — but the shape is contracted here so the webapp cannot
 * drift from the daemon.
 */
export const piAuthSchema = z.object({
  /** At least one provider has ready credentials. */
  ready: z.boolean(),
  /** Providers whose `pi auth check` reports `"status":"ready"`. */
  providers: z.array(z.string()),
  /** pi's saved startup default provider, when configured. */
  defaultProvider: z.string().nullable(),
  /** pi's saved startup default model, when configured. */
  defaultModel: z.string().nullable(),
  /** Human-readable explanation, suitable for surfacing in the UI. */
  detail: z.string(),
  /**
   * True when this is the last-known payload served stale-while-revalidate
   * (issue #100): a background refresh is already running. Absent on a
   * freshly probed payload. Status endpoints must never block on the probe
   * (a full pass can cost one pi spawn per provider), so consumers can
   * treat a `stale` payload as advisory.
   */
  stale: z.boolean().optional(),
});
export type PiAuth = z.infer<typeof piAuthSchema>;

/**
 * Response body of the daemon's gh-auth probe (`GET /api/gh-auth`, mirroring
 * `GET /api/pi-auth`): gh auth status + repo-creation permission. A
 * non-contract route — the shape is contracted here so the webapp cannot
 * drift from the daemon.
 */
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

/**
 * The installer's recorded shell-onboarding results — the normalized shape
 * of `~/.pideck/onboarding.json` as written by `install/onboard.sh`.
 */
export const onboardingRecordSchema = z.object({
  /** ISO timestamp of the shell onboarding run. */
  onboardedAt: z.string(),
  pi: z.object({
    /** "ready" or "none" (per install/onboard.sh). */
    authStatus: z.string(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
  }),
  gh: z.object({
    /** "ready" or "none" (per install/onboard.sh). */
    authStatus: z.string(),
    user: z.string().nullable(),
    /** Whether the granted scopes allow repo creation; null when unknown. */
    canCreateRepo: z.boolean().nullable(),
  }),
});
export type OnboardingRecord = z.infer<typeof onboardingRecordSchema>;

/**
 * Response body of `GET /api/onboarding` (issue #165): the one shared source
 * of truth for onboarding state, so the webapp wizard never re-asks a step
 * the shell onboarding already completed. Combines the installer's recorded
 * results (null when the shell onboarding never ran) with the live daemon
 * pi/gh auth probes. Non-contract route like `/api/pi-auth`.
 */
export const onboardingStateSchema = z.object({
  recorded: onboardingRecordSchema.nullable(),
  piAuth: piAuthSchema,
  ghAuth: ghAuthSchema,
});
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

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

/**
 * Files changed by one worker (issue #126): the worker's PR files once a PR
 * exists, or a branch-vs-base comparison against the project's default
 * branch while work is still mid-flight (no PR open yet). Derives from
 * `pullRequestDiffSchema` (files + unified patch) so the webapp renders
 * both through one view.
 */
export const workerFilesChangedSchema = pullRequestDiffSchema
  .omit({ projectId: true, prNumber: true })
  .extend({
    workerId: z.string().min(1),
    projectId: z.string().min(1),
    /** Where the list came from: the worker's PR or a branch-vs-base compare. */
    source: z.enum(["pr", "branch"]),
    /** PR backing the list; `null` while the diff comes from the branch compare. */
    prNumber: refNumberSchema.nullable(),
  });
export type WorkerFilesChanged = z.infer<typeof workerFilesChangedSchema>;

/**
 * Live progress of a running `pideck update` (issue #89): the update shim
 * (install/lib/update.sh) rewrites a small state file at each stage, and the
 * daemon serves it so the webapp banner can show real progress during the
 * multi-minute fetch/rebuild. Written by the shim, so `stage` is one of its
 * known values (checking/fetching/building/installing/restarting/done/failed)
 * — kept a free string so shim and daemon cannot drift into a parse failure.
 */
export const updateApplyProgressSchema = z.object({
  /** Stage label written by the update shim (see install/lib/update.sh). */
  stage: z.string().min(1),
  /** When the shim last rewrote the state file (ISO timestamp). */
  updatedAt: z.iso.datetime(),
  /**
   * Human-readable failure detail, written by the shim when `stage` is
   * `failed` (issue #198: a bare `failed` is undebuggable — the dev server's
   * apply died silently because the child's output went nowhere).
   */
  error: z.string().min(1).optional(),
});
export type UpdateApplyProgress = z.infer<typeof updateApplyProgressSchema>;

/** PR summary for lists/views; diff bodies are fetched separately. */
export const pullRequestSummarySchema = pullRequestSchema;
export type PullRequestSummary = PullRequest;

/**
 * Result of a self-update check (issue #55): the daemon's local source
 * revision (`git rev-parse HEAD` at `~/.pideck/src`) compared against the
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
  /**
   * `true` only when the RUNNING build and the upstream head both resolved
   * and differ (issue #198): the comparison is against `runningSha` (falling
   * back to `localSha` when the boot SHA could not be captured), not the
   * source checkout — a crashed apply leaves the source already reset to the
   * target while the daemon still runs the old build, and a source-only
   * comparison reported "up to date" with the stale build still serving.
   */
  updateAvailable: z.boolean(),
  /**
   * `true` when the running build is older than the source checkout (issue
   * #198): the apply fetched/built but its restart did not happen yet — the
   * daemon needs a restart, not (another) fetch.
   */
  runningBehindSource: z.boolean(),
  /** When the check ran (ISO timestamp). */
  checkedAt: z.iso.datetime(),
  /** Human-readable failure detail (`null` when the check succeeded). */
  error: z.string().nullable(),
  /**
   * Full SHA of the build the *answering daemon process* runs (captured once
   * at daemon startup, issue #89): the source checkout (`localSha`) moves to
   * the new commit mid-update — before the rebuild/restart — so the webapp's
   * updating-state may only resolve when `runningSha` equals the target SHA.
   * `null` when it could not be captured (no git repo at startup).
   */
  runningSha: z.string().min(1).nullable(),
  /**
   * Live progress of a running `pideck update` shim (issue #89), served
   * fresh even when the gh check itself is cached; `null` when no update has
   * run recently (staleness window in apps/daemon/src/api/update.ts).
   */
  applyProgress: updateApplyProgressSchema.nullable(),
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

/**
 * Webapp-facing update status (issue #76): the check result (issue #55) plus
 * the live active-worker count that gates click-to-apply — the server is the
 * source of truth, so the banner button disables on the same data the apply
 * endpoint gates with (`ACTIVE_WORKER_STATUSES`).
 */
export const updateStatusResponseSchema = updateStatusSchema.extend({
  /** Workers in an `ACTIVE_WORKER_STATUSES` status; > 0 blocks applying. */
  activeWorkers: z.number().int().min(0),
  /** The node version this daemon process runs on (issue #202). */
  nodeVersion: z.string(),
  /** pi's node floor the daemon validates against (install: PD_NODE_MIN_VERSION). */
  nodeMinVersion: z.string(),
  /** `true` when the daemon's node is too old for the pi sessions it spawns. */
  nodeTooOld: z.boolean(),
});
export type UpdateStatusResponse = z.infer<typeof updateStatusResponseSchema>;

/** Body of `POST /api/update/apply` (issue #76): accepted → apply started. */
export const updateApplyResponseSchema = z.object({ ok: z.boolean() });
export type UpdateApplyResponse = z.infer<typeof updateApplyResponseSchema>;

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

  /**
   * Terminate a worker (issue #64): kills its tmux session (which ends the
   * pi process), marks the worker `archived` — a terminal status — and
   * keeps the registry records (session + worker) for history. Idempotent
   * and safe on already-dead panes: a missing tmux session is not an
   * error, and re-terminating an archived worker succeeds. Archived
   * workers are never resurrected by reconcile and never count as active
   * (badges / concurrency cap).
   */
  terminateWorker: {
    method: "POST",
    path: "/api/workers/:workerId/terminate",
    params: z.object({ workerId: z.string().min(1) }),
    request: null,
    response: workerSchema,
  },

  /**
   * Archived worker session log (issue #104): the tmux scrollback captured
   * at termination plus the worker's final metadata (status, issue, PR,
   * timestamps). 404 for unknown workers and for workers that are not
   * archived — a live worker has no archived log yet.
   */
  getArchivedWorkerLog: {
    method: "GET",
    path: "/api/workers/:workerId/log",
    params: z.object({ workerId: z.string().min(1) }),
    request: null,
    response: archivedWorkerLogSchema,
  },

  /**
   * Files changed by a worker (issue #126): the worker's PR files when one
   * exists, otherwise its branch's diff against the project's default branch
   * (`gh` compare, with a local `git diff` fallback while the branch is not
   * pushed yet). Works for archived workers via their recorded PR/branch —
   * 404 for unknown workers, 409 when neither is resolvable.
   */
  getWorkerFilesChanged: {
    method: "GET",
    path: "/api/workers/:workerId/files-changed",
    params: z.object({ workerId: z.string().min(1) }),
    request: null,
    response: workerFilesChangedSchema,
  },

  /**
   * Relaunch a dead session's tmux pane (issue #117): kills any lingering
   * tmux session of the same name (idempotent weird-state cleanup), then
   * re-runs the session's launch path — orchestrator sessions are recreated
   * in their recorded cwd with a plain shell; worker sessions are re-spawned
   * from their recorded cwd/command (the #27 resurrection machinery,
   * user-triggered). The registry record (session + worker) is preserved, so
   * identity and history survive; only the pane is new. Archived sessions
   * are rejected (409) — their history is #104's read-only log view.
   */
  relaunchSession: {
    method: "POST",
    path: "/api/sessions/:sessionId/relaunch",
    params: z.object({ sessionId: z.string().min(1) }),
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

  // Self-update (issues #55, #76)
  getUpdateStatus: {
    method: "GET",
    path: "/api/update",
    params: z.object({}),
    request: null,
    response: updateStatusResponseSchema,
  },
  /**
   * Apply a pending update (issue #76): gates server-side on zero active
   * workers (409 otherwise), then spawns the installed `pideck update`
   * shim detached and returns immediately — the daemon restarts mid-apply,
   * so the webapp polls `GET /api/update` until it reports the new build.
   */
  applyUpdate: {
    method: "POST",
    path: "/api/update/apply",
    params: z.object({}),
    request: null,
    response: updateApplyResponseSchema,
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
  listAccessibleRepos: { method: "GET", path: "/api/gh/repos", params: z.object({}), request: null, response: z.array(accessibleRepoSchema) }, // issue #217
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
