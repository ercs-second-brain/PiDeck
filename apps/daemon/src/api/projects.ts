/**
 * Project store + service: registration (clone an existing repo / create a
 * new GitHub repo), CRUD, and persistence under the daemon state dir
 * (`<stateDir>/projects.json`).
 *
 * GitHub/git work is delegated to the `@agentskiss/daemon` github module
 * (`cloneRepo`, `createRepo`); both are injectable so tests run without
 * network access.
 */

import { z } from "zod";
import {
  projectSchema,
  type Project,
  type ProjectSettings,
} from "@agentskiss/shared";

import type { UpdateProjectRequest } from "@agentskiss/shared";

import { JsonStore } from "./store.js";
import type { ProjectLayout } from "../sessions/layout.js";
import {
  cloneRepo,
  createRepo,
  defaultGitRunner,
  GhClient,
  parseRepoUrl,
  type GitRunner,
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
    workerConcurrency: patch.workerConcurrency !== undefined ? patch.workerConcurrency : base.workerConcurrency,
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

  constructor(deps: ProjectServiceDeps) {
    this.store = deps.store;
    this.layout = deps.layout;
    this.defaultSettings = deps.defaultSettings ?? (() => DEFAULT_PROJECT_SETTINGS);
    this.gh = deps.gh ?? (() => new GhClient());
    this.git = deps.git ?? defaultGitRunner;
    this.now = deps.now ?? (() => new Date());
    this.onChange = deps.onChange ?? (() => {});
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
    const repoUrl =
      input.mode === "clone"
        ? (input.repoUrl as string)
        : await this.createRemoteRepo(input);
    const id = await this.deriveId(input.name, repoUrl, input.mode);
    if (this.store.get(id) !== undefined) {
      throw new ConflictError(`project id "${id}" is already registered`);
    }
    await cloneRepo(this.git, repoUrl, this.layout.cloneDir(id));
    const defaultBranch = input.defaultBranch ?? (await this.detectDefaultBranch(id));
    const now = this.now().toISOString();
    const project: Project = {
      id,
      name: input.name ?? id,
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

  delete(id: string): boolean {
    const deleted = this.store.delete(id);
    if (deleted) this.onChange();
    return deleted;
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

/** Slugifies a project name/id for filesystem- and tmux-safe identifiers. */
export function slugify(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) throw new Error(`cannot slugify project name: ${name}`);
  return cleaned;
}
