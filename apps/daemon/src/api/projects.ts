/**
 * Project store + service: registration (clone an existing repo / create a
 * new GitHub repo), CRUD, and persistence under the daemon state dir
 * (`<stateDir>/projects.json`).
 *
 * GitHub/git work is delegated to the `@pideck/daemon` github module
 * (`cloneRepo`, `createRepo`); both are injectable so tests run without
 * network access.
 */

import { z } from "zod";
import {
  GLOBAL_AGENT_PROJECT_ID,
  projectSchema,
  type Project,
  type ProjectSettings,
  type Worker,
} from "@pideck/shared";

import type { UpdateProjectRequest } from "@pideck/shared";

import { JsonStore } from "../json-store.js";
import type { ProjectLayout } from "../sessions/layout.js";
import {
  cloneRepo,
  createRepo,
  defaultGitRunner,
  GhClient,
  parseRepoUrl,
  type GitRunner,
  GitError,
} from "../github/index.js";

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const persistedSchema = z.object({
  version: z.literal(1),
  projects: z.array(projectSchema),
});

interface Persisted {
  version: 1;
  projects: Project[];
}

/** Per-project settings with only the fields the shared contract defines. */
export type ProjectSettingsPatch = Partial<Pick<ProjectSettings, "autoAgentUsername" | "workerConcurrency">>;

/** Extracts the stored project settings from a request's optional patch. */
export function resolveSettings(
  base: ProjectSettings,
  patch: ProjectSettingsPatch | undefined,
): ProjectSettings {
  if (patch === undefined) return base;
  return {
    autoAgentUsername: patch.autoAgentUsername !== undefined ? patch.autoAgentUsername : base.autoAgentUsername,
    // Issue #168: `undefined` = field not sent (keep the base); `null` =
    // explicitly cleared → unbounded (issue #14 semantics); a number = cap.
    // Normalizing `null` → `undefined` here keeps every stored project and
    // consumer seeing plain unset semantics.
    workerConcurrency:
      patch.workerConcurrency === undefined ? base.workerConcurrency : (patch.workerConcurrency ?? undefined),
  };
}

export class ProjectStore {
  private readonly file: JsonStore<Persisted>;
  private readonly projects = new Map<string, Project>();

  constructor(stateDir: string) {
    this.file = new JsonStore<Persisted>(`${stateDir}/projects.json`);
    const loaded = this.file.load(
      (value) => {
        const parsed = persistedSchema.safeParse(value);
        return parsed.success ? (parsed.data as Persisted) : undefined;
      },
      { version: 1, projects: [] },
    );
    for (const project of loaded.projects) this.projects.set(project.id, project);
  }

  list(): Project[] {
    return [...this.projects.values()];
  }

  get(id: string): Project | undefined {
    return this.projects.get(id);
  }

  put(project: Project): void {
    this.projects.set(project.id, project);
    this.save();
  }

  delete(id: string): boolean {
    const deleted = this.projects.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  private save(): void {
    this.file.save({ version: 1, projects: this.list() });
  }
}

// ---------------------------------------------------------------------------
// Registration service
// ---------------------------------------------------------------------------

export interface RegisterProjectInput {
  mode: "clone" | "create";
  repoUrl?: string;
  name?: string;
  isPrivate?: boolean;
  defaultBranch?: string;
  settings?: ProjectSettingsPatch;
}

export interface ProjectServiceDeps {
  store: ProjectStore;
  layout: ProjectLayout;
  /**
   * Daemon-wide defaults seeded into newly registered projects
   * (`agent/README.md`: default auto-agent username + default worker
   * concurrency are applied to new projects). Defaults to disabled
   * auto-spawn and an unbounded cap (issue #14 semantics).
   */
  defaultSettings?: () => ProjectSettings;
  /** GhClient factory; overridable in tests. */
  gh?: (repoUrl: string) => GhClient;
  git?: GitRunner;
  now?: () => Date;
  /**
   * Called after every mutation (register/update/delete) so the daemon
   * wiring can re-sync per-project watchers/pipelines (issue #46).
   */
  onChange?: () => void;
  /**
   * Local project-deletion plumbing (issue #172): the pieces of the daemon
   * a delete must tear down. Optional so standalone constructions (tests)
   * keep the plain unregister behavior; the daemon context always wires it.
   */
  teardown?: ProjectTeardown;
}

/**
 * The collaborators a local project delete (issue #172) drives, in the
 * order {@link ProjectService.delete} calls them:
 * stop pipeline watching → terminate orchestrator/worker tmux sessions →
 * remove local state files → drop kanban cache → unregister. The GitHub
 * repo is NEVER touched — there is deliberately no hook for it.
 */
export interface ProjectTeardown {
  /** The project's workers in an active (non-terminal) status — the delete
   * guard: active workers driving a PR refuse deletion (409). */
  activeWorkers: (projectId: string) => Worker[];
  /** Stops the project's watcher/pipelines ({@link GithubAutomation.stopProject}). */
  stopWatching: (projectId: string) => void;
  /** Kills the project's tmux sessions and drops their registry records
   * (+ archived logs) ({@link SessionManager.teardownProject}). */
  teardownSessions: (projectId: string) => Promise<unknown>;
  /** Removes the project's local state dirs/files ({@link ProjectLayout.removeProjectState}). */
  removeFiles: (projectId: string) => void;
  /** Drops the project's cached kanban board (boards derive from GitHub + workers). */
  forgetBoard: (projectId: string) => void;
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  autoAgentUsername: null,
};

export class ProjectService {
  private readonly store: ProjectStore;
  private readonly layout: ProjectLayout;
  private readonly defaultSettings: () => ProjectSettings;
  private readonly gh: (repoUrl: string) => GhClient;
  private readonly git: GitRunner;
  private readonly now: () => Date;
  private readonly onChange: () => void;
  private readonly teardown: ProjectTeardown | undefined;

  constructor(deps: ProjectServiceDeps) {
    this.store = deps.store;
    this.layout = deps.layout;
    this.defaultSettings = deps.defaultSettings ?? (() => DEFAULT_PROJECT_SETTINGS);
    this.gh = deps.gh ?? (() => new GhClient());
    this.git = deps.git ?? defaultGitRunner;
    this.now = deps.now ?? (() => new Date());
    this.onChange = deps.onChange ?? (() => {});
    this.teardown = deps.teardown;
  }

  list(): Project[] {
    return this.store.list();
  }

  get(id: string): Project | undefined {
    return this.store.get(id);
  }

  /**
   * Registers a project:
   * - `clone`: clones `repoUrl` into `<stateDir>/projects/<id>/clone`.
   * - `create`: creates a new (private-by-default) GitHub repo via `gh`, then
   *   clones it.
   */
  async register(input: RegisterProjectInput): Promise<Project> {
    const id = await this.deriveId(input.name, input.mode === "clone" ? (input.repoUrl as string) : "", input.mode);
    // `global` is the reserved pseudo-project id of the workspace-level
    // global agent session — a registered project under it would collide
    // with the global agent's registry records, dirs, and tmux names.
    // Checked before the remote repo is created/cloned (create mode would
    // otherwise open a GitHub repo that then cannot be registered).
    if (id === GLOBAL_AGENT_PROJECT_ID) {
      throw new ConflictError(`project id "${id}" is reserved for the global agent`);
    }
    const repoUrl =
      input.mode === "clone"
        ? (input.repoUrl as string)
        : await this.createRemoteRepo(input);
    if (this.store.get(id) !== undefined) {
      throw new ConflictError(`project id "${id}" is already registered`);
    }
    try {
      await cloneRepo(this.git, repoUrl, this.layout.cloneDir(id));
    } catch (err) {
      // Issue #216: a failed initial clone is a client-side problem (bad URL,
      // missing repo, no gh access) → 4xx with an actionable message, not a
      // raw 500 carrying the git command line.
      if (err instanceof GitError) throw new CloneFailedError(repoUrl, err);
      throw err;
    }
    const defaultBranch = input.defaultBranch ?? (await this.detectDefaultBranch(id));
    const now = this.now().toISOString();
    const project: Project = {
      id,
      name: input.name ?? this.defaultName(repoUrl, id),
      repoUrl,
      defaultBranch,
      settings: resolveSettings(this.defaultSettings(), input.settings),
      createdAt: now,
      updatedAt: now,
    };
    this.store.put(project);
    this.onChange();
    return project;
  }

  update(id: string, patch: UpdateProjectRequest): Project {
    const existing = this.require(id);
    const now = this.now().toISOString();
    const updated: Project = {
      ...existing,
      name: patch.name ?? existing.name,
      defaultBranch: patch.defaultBranch ?? existing.defaultBranch,
      settings: resolveSettings(existing.settings, patch.settings),
      updatedAt: now,
    };
    this.store.put(updated);
    this.onChange();
    return updated;
  }

  /**
   * Deletes a project **locally** (issue #172): pipeline watching, the
   * orchestrator + worker tmux sessions (and their registry records, incl.
   * archived logs), the clone/state dirs, the kanban cache, and finally the
   * registration. The GitHub repo is never touched.
   *
   * Ordering matters: stop watching first (no pipeline reacts to the
   * disappearing sessions), then terminate sessions, then delete files,
   * then unregister (+ `onChange` re-syncs the automation, a no-op here).
   *
   * Idempotent on partial states: every teardown step tolerates already-
   * gone tmux sessions, files, and records. Refuses with a conflict while
   * active workers are driving a PR — terminate or merge them first.
   * Throws {@link NotFoundError} for unknown projects.
   */
  async delete(id: string): Promise<void> {
    if (this.store.get(id) === undefined) throw new NotFoundError(`unknown project: ${id}`);
    const teardown = this.teardown;
    if (teardown === undefined) {
      this.store.delete(id);
      this.onChange();
      return;
    }
    const driving = teardown
      .activeWorkers(id)
      .filter((worker) => worker.prNumber !== null);
    if (driving.length > 0) {
      throw new ConflictError(
        `project "${id}" has ${driving.length} active worker(s) driving PR ` +
          `(#${driving.map((worker) => worker.prNumber).join(", #")}) — terminate or finish them before deleting`,
      );
    }
    teardown.stopWatching(id);
    await teardown.teardownSessions(id);
    teardown.removeFiles(id);
    teardown.forgetBoard(id);
    this.store.delete(id);
    this.onChange();
  }

  /** Creates the project's on-disk layout (clone/worktrees dirs). Idempotent. */
  ensureLayout(id: string): void {
    this.layout.ensureProject(id);
  }

  private require(id: string): Project {
    const project = this.store.get(id);
    if (project === undefined) throw new NotFoundError(`unknown project: ${id}`);
    return project;
  }

  private async createRemoteRepo(input: RegisterProjectInput): Promise<string> {
    const gh = this.gh("https://github.com/create");
    const created = await createRepo(gh, {
      name: input.name as string,
      isPrivate: input.isPrivate ?? true,
    });
    return created.url;
  }

  /**
   * Project id: explicit `name` (slugified) for `create` mode, else the
   * `owner/repo` slug of the cloned URL (with any explicit name winning).
   */
  private async deriveId(name: string | undefined, repoUrl: string, mode: "clone" | "create"): Promise<string> {
    if (mode === "create" && name !== undefined) return slugify(name);
    try {
      const ref = parseRepoUrl(repoUrl);
      return slugify(`${ref.owner}-${ref.repo}`);
    } catch {
      if (name === undefined) throw new Error(`cannot derive a project id from ${repoUrl}; pass a name`);
      return slugify(name);
    }
  }

  /**
   * Default display name for a clone-registered project: just the repo name,
   * without the owner/author prefix (`.../pidecktest2` → `pidecktest2`).
   * Falls back to the id when the URL is not a parseable GitHub URL. The
   * project id keeps its own derivation ({@link deriveId}).
   */
  private defaultName(repoUrl: string, id: string): string {
    try {
      return parseRepoUrl(repoUrl).repo;
    } catch {
      return id;
    }
  }

  /** Detects the cloned repo's default branch (`git symbolic-ref HEAD`); called after clone. */
  private async detectDefaultBranch(id: string): Promise<string> {
    try {
      const { stdout } = await this.git(["symbolic-ref", "--short", "HEAD"], { cwd: this.layout.cloneDir(id) });
      const branch = stdout.trim();
      return branch.length > 0 ? branch : "main";
    } catch {
      return "main";
    }
  }
}

/** Thrown for 404s (unknown project) — mapped by the router's error path. */
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
  readonly statusCode = 404;
  constructor(message: string) {
    super(message);
  }
}

/** Thrown for 409s (duplicate project id, concurrency cap reached). */
export class ConflictError extends Error {
  override readonly name = "ConflictError";
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown when the registration's initial clone fails — mapped to 4xx by the
 * router's error path (issue #216).
 */
class CloneFailedError extends Error {
  override readonly name = "CloneFailedError";
  readonly statusCode = 400;
  constructor(repoUrl: string, cause: GitError) {
    super(`repo not found at ${repoUrl} — check the name and your gh access\n${cause.stderr.trim()}`);
  }
}

/**
 * Slugifies a project name/id for filesystem- and tmux-safe identifiers.
 * Case is preserved (issue #216): the directory slug must match the repo
 * URL's casing instead of silently diverging from it.
 */
export function slugify(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) throw new Error(`cannot slugify project name: ${name}`);
  return cleaned;
}
