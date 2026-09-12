import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { statePaths } from "./stateDir.js";
import { z } from "zod";
import {
  ProjectCreateSchema,
  ProjectSchema,
  ProjectSettingsSchema,
  type Project,
  type ProjectCreate,
  type ProjectSettings,
} from "@pideck/shared";
import { GhClient } from "../github/client.js";
import { ensureReviewAccess } from "../github/reviewAccess.js";
import { GlobalSettingsStore } from "./globalSettingsStore.js";
import { JsonFile } from "./jsonFile.js";

const ProjectRecordSchema = z.object({
  project: ProjectSchema,
  settings: ProjectSettingsSchema,
});

const ProjectsFileSchema = z.object({ projects: z.array(ProjectRecordSchema) });

type ProjectRecord = z.infer<typeof ProjectRecordSchema>;
type ProjectsFile = z.infer<typeof ProjectsFileSchema>;

export type CommandRunner = (cmd: string, args: string[], cwd?: string) => { stdout: string };

/** Overridable review-access check run when a project is registered. */
export type ReviewAccessCheck = (repo: { owner: string; repo: string }) => Promise<void>;

export function runCommand(cmd: string, args: string[], cwd?: string): { stdout: string } {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout };
  } catch (err) {
    const stderr = typeof (err as { stderr?: unknown }).stderr === "string"
      ? (err as { stderr: string }).stderr.trim()
      : "";
    const detail = stderr || (err as Error).message;
    throw new Error(`\`${cmd} ${args.join(" ")}\` failed: ${detail}`);
  }
}

export function parseRepoUrl(url: string): { owner: string; repo: string } {
  const withoutSuffix = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const parts = withoutSuffix.split(/[/:]/).filter(Boolean);
  const repo = parts.at(-1);
  const owner = parts.at(-2);
  if (!owner || !repo) {
    throw new Error(`not a repository URL: ${url}`);
  }
  return { owner, repo };
}

function slug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

/**
 * Registered projects persisted at `<stateDir>/projects.json`. `add` clones an
 * existing repo or creates one with `gh repo create`, always landing the clone
 * at `<stateDir>/projects/<id>/clone`, then guarantees the review account can
 * read the repo (check, invite with push, accept — never fatal: the reconciler
 * re-checks every poll and reports what it cannot fix). `remove` deletes the
 * whole `<stateDir>/projects/<id>` directory — clone included.
 */
export class ProjectStore {
  private file: JsonFile<ProjectsFile>;
  private projectRoot: string;
  private stateDir: string;
  private reviewAccess?: ReviewAccessCheck;
  private settingsStore: GlobalSettingsStore | null = null;

  constructor(stateDir: string, private run: CommandRunner = runCommand, reviewAccess?: ReviewAccessCheck) {
    const paths = statePaths(stateDir);
    this.file = new JsonFile(paths.projectsFile, ProjectsFileSchema, { projects: [] });
    this.projectRoot = paths.projectsDir;
    this.stateDir = stateDir;
    this.reviewAccess = reviewAccess;
    this.file.load();
  }

  async add(input: ProjectCreate): Promise<Project> {
    const create = ProjectCreateSchema.parse(input);
    const records = this.file.load().projects;

    const project =
      create.mode === "clone"
        ? this.addClone(records, create.repoUrl, create.name ?? null)
        : this.addCreate(records, create.name, create.private);

    return this.finishAdd(records, project);
  }

  private async finishAdd(records: ProjectRecord[], project: Project): Promise<Project> {
    try {
      await this.ensureReviewAccess(project);
    } catch {
      // Access problems surface through the reconciler's per-tick re-check.
    }
    records.push({
      project,
      settings: ProjectSettingsSchema.parse({}),
    });
    this.file.write({ projects: records });
    return project;
  }

  list(): Project[] {
    return this.file.load().projects.map((record) => record.project);
  }

  get(id: string): Project {
    return this.record(id).project;
  }

  settings(id: string): ProjectSettings {
    return this.record(id).settings;
  }

  updateSettings(id: string, patch: Partial<ProjectSettings>): ProjectSettings {
    const records = this.file.load().projects;
    const record = this.find(records, id);
    const settings = ProjectSettingsSchema.parse({ ...record.settings, ...patch });
    record.settings = settings;
    this.file.write({ projects: records });
    return settings;
  }

  remove(id: string): void {
    const records = this.file.load().projects;
    this.find(records, id);
    rmSync(join(this.projectRoot, id), { recursive: true, force: true });
    this.file.write({ projects: records.filter((record) => record.project.id !== id) });
  }

  private ensureReviewAccess(project: Pick<Project, "owner" | "repo">): Promise<void> {
    if (this.reviewAccess !== undefined) {
      return this.reviewAccess({ owner: project.owner, repo: project.repo }).then(() => undefined);
    }
    const account = this.globalSettings().reviewToken();
    if (account === null) return Promise.resolve();
    const repo = `${project.owner}/${project.repo}`;
    return ensureReviewAccess({
      primary: new GhClient({ repo }),
      review: new GhClient({ repo, token: account.token }),
      reviewLogin: account.username,
      repo,
    }).then(() => undefined);
  }

  private globalSettings(): GlobalSettingsStore {
    return (this.settingsStore ??= new GlobalSettingsStore(this.stateDir));
  }

  private addClone(records: ProjectRecord[], repoUrl: string, name: string | null): Project {
    const { owner, repo } = parseRepoUrl(repoUrl);
    const project = this.materialize(records, {
      name: name ?? repo,
      repoUrl,
      owner,
      repo,
    });
    this.run("git", ["clone", repoUrl, project.path]);
    project.defaultBranch = this.defaultBranch(project.path);
    return project;
  }

  private addCreate(records: ProjectRecord[], name: string, privateRepo: boolean): Project {
    const url = this.run("gh", ["repo", "create", name, privateRepo ? "--private" : "--public"])
      .stdout.trim();
    const repoUrl = url.match(/https?:\/\/\S+|file:\/\/\S+|git@\S+/)?.[0];
    if (!repoUrl) {
      throw new Error(`\`gh repo create\` did not return a repository URL: ${url}`);
    }
    const { owner, repo } = parseRepoUrl(repoUrl);
    const project = this.materialize(records, {
      name,
      repoUrl,
      owner,
      repo,
    });
    this.run("git", ["clone", repoUrl, project.path]);
    project.defaultBranch = this.defaultBranch(project.path);
    return project;
  }

  private materialize(
    records: ProjectRecord[],
    fields: { name: string; repoUrl: string; owner: string; repo: string },
  ): Project {
    const id = this.uniqueId(records, slug(`${fields.owner}-${fields.repo}`));
    return ProjectSchema.parse({
      id,
      name: fields.name,
      repoUrl: fields.repoUrl,
      owner: fields.owner,
      repo: fields.repo,
      defaultBranch: "",
      path: join(this.projectRoot, id, "clone"),
    });
  }

  private defaultBranch(cloneDir: string): string {
    // `rev-parse HEAD` fails on a freshly created repo with no commits, so use
    // `symbolic-ref`, which also respects init.defaultBranch on an unborn HEAD.
    try {
      return this.run("git", ["symbolic-ref", "--short", "HEAD"], cloneDir).stdout.trim();
    } catch {
      return "main";
    }
  }

  private uniqueId(records: ProjectRecord[], base: string): string {
    const taken = new Set(records.map((record) => record.project.id));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private find(records: ProjectRecord[], id: string): ProjectRecord {
    const record = records.find((entry) => entry.project.id === id);
    if (!record) throw new Error(`unknown project: ${id}`);
    return record;
  }

  private record(id: string): ProjectRecord {
    return this.find(this.file.load().projects, id);
  }
}
