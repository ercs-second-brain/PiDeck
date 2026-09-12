/**
 * Session lifecycle: spawn a pi session into tmux, archive it, and
 * reconcile the registry with live tmux state at startup.
 *
 * The cwd each persona gets:
 * - worker: a fresh git worktree of the project clone (the `cwd` argument)
 *   on branch `pideck/issue-<n>`, based on the default branch (resolved
 *   from `origin/HEAD`, falling back to the clone's own HEAD). If the
 *   branch already exists — a replaced worker — the worktree reuses it
 *   instead of resetting, so in-progress work survives replacement.
 * - reviewer: a detached worktree of the PR head (fetched from
 *   `pull/<n>/head`).
 * - orchestrator/global: the clone itself.
 *
 * Worktrees live under `<stateDir>/worktrees/<sessionId>` so project
 * clones stay clean; they are removed on archive. Each pane runs pi with
 * `--session-dir <stateDir>/pi-sessions/<sessionId>` so the session's JSONL
 * lives at a path PiDeck chose (see context.ts); removed on archive too.
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { SessionSchema, type Persona, type Session } from "@pideck/shared";
import { Tmux } from "./tmux.js";
import type { SessionRegistry } from "./registry.js";

export interface SpawnPiOptions {
  persona: Persona;
  projectId: string | null;
  /** Project clone the session works from (worker/reviewer get a worktree). */
  cwd: string;
  systemPrompt: string;
  model: string | null;
  env?: Record<string, string>;
  issueNumber?: number;
  prNumber?: number;
}

export interface SpawnDeps {
  tmux: Tmux;
  registry: SessionRegistry;
  /** State dir: worktrees, system prompts, and logs live under it. */
  stateDir: string;
  git?: GitRunner;
}

export type GitRunner = (args: string[], options?: { cwd: string }) => Promise<string>;

export function defaultGitRunner(): GitRunner {
  return (args, options) =>
    new Promise((resolve, reject) => {
      const child = spawn("git", args, {
        ...(options ?? {}),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`));
      });
    });
}

export function worktreeDir(stateDir: string, sessionId: string): string {
  return join(stateDir, "worktrees", sessionId);
}

/** The branch a fresh worktree starts from: `origin/HEAD` or the clone's HEAD. */
async function defaultBranch(git: GitRunner, clone: string): Promise<string> {
  try {
    const ref = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: clone,
    });
    return ref.trim().replace(/^origin\//, "");
  } catch {
    const head = await git(["rev-parse", "HEAD"], { cwd: clone });
    return head.trim();
  }
}

async function branchExists(git: GitRunner, clone: string, branch: string): Promise<boolean> {
  try {
    await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: clone });
    return true;
  } catch {
    return false;
  }
}

async function createWorkerWorktree(
  git: GitRunner,
  clone: string,
  path: string,
  branch: string,
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  if (await branchExists(git, clone, branch)) {
    await git(["worktree", "add", path, branch], { cwd: clone });
  } else {
    const base = await defaultBranch(git, clone);
    await git(["worktree", "add", "-b", branch, path, base], { cwd: clone });
  }
}

async function createReviewerWorktree(
  git: GitRunner,
  clone: string,
  path: string,
  prNumber: number,
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await git(["fetch", "origin", `pull/${prNumber}/head`], { cwd: clone });
  await git(["worktree", "add", "--detach", path, "FETCH_HEAD"], { cwd: clone });
}

/** Removes a session's worktree; prunes the repo's worktree metadata. */
export function removeWorktree(
  git: GitRunner,
  clone: string | null,
  path: string,
): void {
  rmSync(path, { recursive: true, force: true });
  if (clone !== null) {
    git(["worktree", "prune"], { cwd: clone }).catch(() => {});
  }
}

/** Launches pi in tmux and registers the session. Returns the record. */
export async function spawnPiSession(deps: SpawnDeps, options: SpawnPiOptions): Promise<Session> {
  const id = randomUUID();
  const tmuxSession = `pideck-${id}`;
  const git = deps.git ?? defaultGitRunner();

  let cwd = options.cwd;
  if (options.persona === "worker" && options.issueNumber !== undefined) {
    cwd = worktreeDir(deps.stateDir, id);
    await createWorkerWorktree(
      git,
      options.cwd,
      cwd,
      `pideck/issue-${options.issueNumber}`,
    );
  } else if (options.persona === "reviewer" && options.prNumber !== undefined) {
    cwd = worktreeDir(deps.stateDir, id);
    await createReviewerWorktree(git, options.cwd, cwd, options.prNumber);
  }

  const promptFile = join(deps.stateDir, "system-prompts", `${id}.md`);
  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, options.systemPrompt, "utf8");

  // Pin pi's session storage to a path we own: the context probe reads the
  // JSONL from here without reconstructing pi's internal cwd-slug layout.
  const piSessionDir = join(deps.stateDir, "pi-sessions", id);
  mkdirSync(piSessionDir, { recursive: true });

  const command = [
    "pi",
    "--session-dir",
    piSessionDir,
    "--append-system-prompt",
    promptFile,
    ...(options.model ? ["--model", options.model] : []),
  ];
  await deps.tmux.create(tmuxSession, {
    cwd,
    windowName: options.persona,
    command,
    env: { ...options.env, PD_SESSION_ID: id },
  });
  // A pane that is still booting swallows the first typed line; deliver only
  // once pi's chrome has settled. Bounded — see Tmux.waitReady.
  await deps.tmux.waitReady(tmuxSession);

  const session = SessionSchema.parse({
    id,
    persona: options.persona,
    projectId: options.projectId,
    ...(options.issueNumber !== undefined ? { issueNumber: options.issueNumber } : {}),
    ...(options.prNumber !== undefined ? { prNumber: options.prNumber } : {}),
    tmuxSession,
    spawnedAt: new Date().toISOString(),
    model: options.model,
  });
  deps.registry.add(session);
  return session;
}

export interface ArchiveDeps {
  tmux: Tmux;
  registry: SessionRegistry;
  stateDir: string;
  git?: GitRunner;
  /** Project clone the session was created from (for worktree pruning). */
  cloneDir: string | null;
}

/**
 * Archives a session: captures the pane scrollback to
 * `<stateDir>/logs/<sessionId>.log`, kills the tmux session, removes the
 * session's worktree, and marks the record archived (kept). A pane that is
 * already gone skips straight to cleanup — its scrollback died with it.
 */
export async function archiveSession(deps: ArchiveDeps, session: Session): Promise<Session> {
  if (await deps.tmux.isAlive(session.tmuxSession)) {
    const log = await deps.tmux.capturePane(session.tmuxSession);
    const logFile = join(deps.stateDir, "logs", `${session.id}.log`);
    mkdirSync(dirname(logFile), { recursive: true });
    writeFileSync(logFile, `${log}\n`, "utf8");
    await deps.tmux.kill(session.tmuxSession);
  }
  removeWorktree(deps.git ?? defaultGitRunner(), deps.cloneDir, worktreeDir(deps.stateDir, session.id));
  rmSync(join(deps.stateDir, "system-prompts", `${session.id}.md`), { force: true });
  rmSync(join(deps.stateDir, "pi-sessions", session.id), { recursive: true, force: true });
  return deps.registry.archive(session.id);
}

/**
 * Startup reconciliation: every non-archived record whose tmux session is
 * gone is reported dead. Records are NOT archived here — the reconciler
 * decides replacement (fresh session for the same issue/PR). The shared
 * `Session` contract carries no dead flag, so deadness is reported to the
 * caller instead of persisted; consumers can re-derive it from tmux at any
 * time.
 */
export async function reconcileWithTmux(
  registry: SessionRegistry,
  tmux: Tmux,
): Promise<{ dead: Session[] }> {
  const dead: Session[] = [];
  for (const session of registry.list({ archived: false })) {
    if (!(await tmux.isAlive(session.tmuxSession))) dead.push(session);
  }
  return { dead };
}
