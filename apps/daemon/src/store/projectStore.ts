import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ProjectCreateSchema,
  ProjectSchema,
  ProjectSettingsSchema,
  type Project,
  type ProjectCreate,
  type ProjectSettings,
} from "@pideck/shared";
import { JsonFile } from "./jsonFile.js";

const ProjectRecordSchema = z.object({
  project: ProjectSchema,
  settings: ProjectSettingsSchema,
});

const ProjectsFileSchema = z.object({ projects: z.array(ProjectRecordSchema) });

type ProjectRecord = z.infer<typeof ProjectRecordSchema>;
type ProjectsFile = z.infer<typeof ProjectsFileSchema>;

export type CommandRunner = (cmd: string, args: string[], cwd?: string) => { stdout: string };

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
 * at `<stateDir>/projects/<id>/clone`. `remove` deletes the whole
 * `<stateDir>/projects/<id>` directory — clone and any worktrees with it.
 */
export class ProjectStore {
  private file: JsonFile<ProjectsFile>;
  private projectRoot: string;

  constructor(stateDir: string, private run: CommandRunner = runCommand) {
    this.file = new JsonFile(join(stateDir, "projects.json"), ProjectsFileSchema, { projects: [] });
    this.projectRoot = join(stateDir, "projects");
    this.file.load();
  }

  add(input: ProjectCreate): Project {
    const create = ProjectCreateSchema.parse(input);
    const records = this.file.load().projects;

    const project =
      create.mode === "clone"
        ? this.addClone(records, create.repoUrl, create.name ?? null)
        : this.addCreate(records, create.name, create.private);

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

  /** Updates editable project fields (name, defaultBranch, path). */
  update(id: string, patch: Partial<Pick<Project, "name" | "defaultBranch" | "path">>): Project {
    const records = this.file.load().projects;
    const record = this.find(records, id);
    record.project = ProjectSchema.parse({ ...record.project, ...patch });
    this.file.write({ projects: records });
    return record.project;
  }

  remove(id: string): void {
    const records = this.file.load().projects;
    this.find(records, id);
    rmSync(join(this.projectRoot, id), { recursive: true, force: true });
    this.file.write({ projects: records.filter((record) => record.project.id !== id) });
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
    const { stdout } = this.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cloneDir);
    return stdout.trim();
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
