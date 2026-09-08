/**
 * Per-project on-disk layout under the daemon state dir:
 *
 *   <stateDir>/projects/<projectId>/           — project root
 *   <stateDir>/projects/<projectId>/clone/     — main repository clone
 *   <stateDir>/projects/<projectId>/worktrees/ — per-task git worktrees
 *   <stateDir>/sessions.json                   — session registry persistence
 */

import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Default daemon state directory (`~/.agentskiss`), overridable via the
 * `AGENTSKISS_HOME` environment variable (set by the service units).
 */
export function defaultStateDir(): string {
  const fromEnv = process.env["AGENTSKISS_HOME"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return path.join(os.homedir(), ".agentskiss");
}

export interface ProjectDirs {
  projectDir: string;
  cloneDir: string;
  worktreesDir: string;
}

/**
 * Replaces characters that are unsafe in filesystem paths or tmux session
 * names (tmux forbids `.` and `:`; we are stricter for consistency).
 */
export function sanitizeSegment(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "project";
}

export class ProjectLayout {
  private readonly stateDir: string;

  constructor(stateDir: string = defaultStateDir()) {
    this.stateDir = stateDir;
  }

  get root(): string {
    return this.stateDir;
  }

  projectsRoot(): string {
    return path.join(this.stateDir, "projects");
  }

  projectDir(projectId: string): string {
    return path.join(this.projectsRoot(), sanitizeSegment(projectId));
  }

  /** Main repository clone for a project. */
  cloneDir(projectId: string): string {
    return path.join(this.projectDir(projectId), "clone");
  }

  worktreesDir(projectId: string): string {
    return path.join(this.projectDir(projectId), "worktrees");
  }

  /** Per-task worktree directory (issue #3 clones; worktree creation lands later). */
  worktreeDir(projectId: string, name: string): string {
    return path.join(this.worktreesDir(projectId), sanitizeSegment(name));
  }

  /** Path of the session registry's JSON persistence file. */
  sessionsFilePath(): string {
    return path.join(this.stateDir, "sessions.json");
  }

  /** Path of the archived-worker scrollback persistence file (issue #104). */
  archivedLogsFilePath(): string {
    return path.join(this.stateDir, "archived-logs.json");
  }

  /** Creates the on-disk layout for a project (idempotent). */
  ensureProject(projectId: string): ProjectDirs {
    const projectDir = this.projectDir(projectId);
    const cloneDir = this.cloneDir(projectId);
    const worktreesDir = this.worktreesDir(projectId);
    mkdirSync(cloneDir, { recursive: true });
    mkdirSync(worktreesDir, { recursive: true });
    return { projectDir, cloneDir, worktreesDir };
  }
}
