/**
 * Worker workspace preparation (issue #287): every default-path worker
 * spawn bases its work on a **fresh** origin — the clone is fetched, and a
 * per-worker worktree is created on a new branch off the remote default
 * branch's current HEAD. Workers can switch/create branches afterwards as
 * the task entails; the guarantee is only that the starting point is
 * current. A fetch failure aborts the spawn loudly rather than starting
 * work on a stale base — main moving between branch point and merge was
 * the top source of PR conflicts (finding B26).
 */

import type { GitRunner } from "../github/repos.js";
import type { ProjectLayout } from "./layout.js";
import { sanitizeTmuxSegment } from "./tmux-commands.js";

/** Result of a successful workspace preparation. */
export interface PreparedWorkspace {
  /** Absolute path of the per-worker worktree (the pane's cwd). */
  path: string;
  /**
   * Best-effort cleanup for the spawn-failure path: removes the worktree
   * so a failed spawn leaves no debris. Never throws.
   */
  discard: () => Promise<void>;
}

/** Options for workspace preparation. */
export interface PrepareWorkspaceOptions {
  /**
   * Explicit base ref — the parent session's checked-out commit (issue
   * #365). The commit is local by construction (checked out in the
   * parent's cwd), so the fetch + origin-HEAD resolution is skipped: the
   * point is the parent's state, not current origin. Absent (default):
   * the #287 fresh-origin path — fetch, resolve origin's default branch,
   * and base on its current HEAD (up-to-date main).
   */
  baseRef?: string;
}

/**
 * Resolves the parent session's code state (issue #365): the commit
 * checked out in the parent's recorded cwd — its code state at spawn
 * time. `null` when the parent has no meaningful state: no recorded cwd,
 * the directory is not a git repo (e.g. the orchestrator's project dir),
 * or the repo has no commits. Callers fall back to the fresh-origin main
 * base on `null`.
 */
export async function resolveParentHead(git: GitRunner, parentCwd: string | undefined): Promise<string | null> {
  if (parentCwd === undefined) return null;
  try {
    const head = (await git(["rev-parse", "HEAD"], { cwd: parentCwd })).stdout.trim();
    return head !== "" ? head : null;
  } catch {
    return null;
  }
}

/**
 * Fetches the project's clone and creates the worker's worktree:
 *
 * 1. `git fetch origin --prune` — mandatory; failure aborts the spawn.
 * 2. resolve the remote default branch via `origin/HEAD` (set by the
 *    daemon's own clone; failure aborts loudly too);
 * 3. prune stale worktree registrations, then `git worktree add -b
 *    pideck/<workerId> <worktreeDir> origin/<default>`.
 *
 * Worker ids are unique and never recycled, so the worktree dir and branch
 * cannot collide with a previous worker's leftovers.
 */
export async function prepareWorkerWorkspace(git: GitRunner, layout: ProjectLayout, projectId: string, workerId: string, options: PrepareWorkspaceOptions = {}): Promise<PreparedWorkspace> {
  const clone = layout.cloneDir(projectId);
  const worktreePath = layout.worktreeDir(projectId, sanitizeTmuxSegment(workerId));
  let base: string;
  if (options.baseRef !== undefined) {
    // Issue #365: the parent's checked-out commit — no fetch, no origin
    // resolution. The commit is local by construction (checked out in the
    // parent's cwd), and fetching would be beside the point (the goal is
    // the parent's state, not current origin).
    base = options.baseRef;
  } else {
    try {
      await git(["fetch", "origin", "--prune"], { cwd: clone });
    } catch (err) {
      throw new Error(
        `worker spawn aborted for project "${projectId}": git fetch failed — refusing to start on a stale base\n${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      const ref = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: clone })).stdout.trim();
      if (!ref.startsWith("origin/") || ref.length === "origin/".length) throw new Error(`unexpected symbolic-ref output: "${ref}"`);
      base = ref;
    } catch (err) {
      throw new Error(
        `worker spawn aborted for project "${projectId}": cannot resolve origin's default branch (is origin/HEAD set?)\n${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Prune leftovers from crashed spawns before adding (idempotent, local).
  await git(["worktree", "prune"], { cwd: clone });
  await git(["worktree", "add", "-b", `pideck/${sanitizeTmuxSegment(workerId)}`, worktreePath, base], { cwd: clone });
  return {
    path: worktreePath,
    discard: async () => {
      try {
        await git(["worktree", "remove", "--force", worktreePath], { cwd: clone });
      } catch {
        // Best effort: the spawn has already failed; never mask its error.
      }
    },
  };
}
