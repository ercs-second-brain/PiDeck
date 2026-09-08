/**
 * Per-project on-disk layout under the daemon state dir:
 *
 *   <stateDir>/projects/<projectId>/           — project root
 *   <stateDir>/projects/<projectId>/clone/     — main repository clone
 *   <stateDir>/projects/<projectId>/worktrees/ — per-task git worktrees
 *   <stateDir>/sessions.json                   — session registry persistence
 */

import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Default daemon state directory (`~/.pideck`), overridable via the
 * `PD_HOME` environment variable (set by the service units).
 */
export function defaultStateDir(): string {
  const fromEnv = process.env["PD_HOME"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return path.join(os.homedir(), ".pideck");
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

  /** PR-tracker persistence for a project (`<stateDir>/pr-tracker/<projectId>.json`).
   * Same path {@link ../pipeline/unit-builder.js} builds for its trackers. */
  prTrackerFilePath(projectId: string): string {
    return path.join(this.stateDir, "pr-tracker", `${projectId}.json`);
  }

  /** Issue-cursor persistence for a project (`<stateDir>/issue-cursor/<projectId>.json`).
   * Same path {@link ../pipeline/unit-builder.js} builds for its cursors. */
  issueCursorFilePath(projectId: string): string {
    return path.join(this.stateDir, "issue-cursor", `${projectId}.json`);
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

  /**
   * Removes ALL of a project's local on-disk state (issue #172 project
   * delete): the project dir (clone, worktrees, orchestrator prompt file)
   * plus its PR-tracker and issue-cursor persistence. Idempotent on partial
   * states (`force` tolerates already-deleted paths). Never touches the
   * GitHub repo — only files under the daemon state dir.
   */
  removeProjectState(projectId: string): void {
    rmSync(this.projectDir(projectId), { recursive: true, force: true });
    rmSync(this.prTrackerFilePath(projectId), { force: true });
    rmSync(this.issueCursorFilePath(projectId), { force: true });
  }
}
