/**
 * Session lifecycle: spawn a pi session into tmux, archive it, and
 * reconcile the registry with live tmux state at startup.
 *
 * The cwd each persona gets:
 * - worker: its own clone of the project clone at
 *   `<stateDir>/sessions/<id>/repo` — same filesystem, so the clone
 *   hardlinks the existing objects and is near-instant. origin is
 *   repointed at the GitHub repo and fetched, so the session branches
 *   from current upstream; the local clone is only a warm object cache.
 *   On branch `pideck/issue-<n>`: checked out against `origin/<default>`
 *   when the branch does not exist upstream, tracking
 *   `origin/pideck/issue-<n>` when it does (a replaced worker keeps
 *   in-progress work).
 * - reviewer: its own clone the same way, then detached at the PR head
 *   (fetched from `pull/<n>/head`).
 * - orchestrator: the project clone itself (it only writes `docs/`), fast-forwarded
 *   to the upstream default branch at spawn — see refreshProjectClone.
 * - global: the state dir itself (no project).
 *
 * A worker without an issue number or a reviewer without a PR number cannot be
 * isolated, so the spawn fails loudly instead of silently sharing the project
 * clone — no persona other than orchestrator/global ever runs there.
 *
 * Each session owns everything under `<stateDir>/sessions/<id>`, removed on
 * archive — no shared `.git`, so one session's `git stash`, `gc`, or hooks
 * can never touch another's. Each pane runs pi with
 * `--session-dir <stateDir>/pi-sessions/<sessionId>` so the session's JSONL
 * lives at a path PiDeck chose (see context.ts); removed on archive too.
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { statePaths } from "../store/stateDir.js";
import {
  SessionSchema,
  errorMessage,
  type Persona,
  type Session,
} from "@pideck/shared";
import { Tmux } from "./tmux.js";
import type { SessionRegistry } from "./registry.js";

export interface SpawnPiOptions {
  persona: Persona;
  projectId: string | null;
  /** Project clone the session works from (worker/reviewer get a clone of it). */
  cwd: string;
  /** Upstream URL the session clone's origin is repointed at. */
  repoUrl?: string;
  systemPrompt: string;
  model: string | null;
  env?: Record<string, string>;
  issueNumber?: number;
  prNumber?: number;
}

export interface SpawnDeps {
  tmux: Tmux;
  registry: SessionRegistry;
  /** State dir: session clones, system prompts, and logs live under it. */
  stateDir: string;
  git?: GitRunner;
  /** Told about clone refreshes that had to be skipped. */
  log?: (line: string) => void;
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

function sessionDir(stateDir: string, sessionId: string): string {
  return join(statePaths(stateDir).sessionsDir, sessionId);
}

/** The project clone a worker/reviewer session works in, under its session dir. */
export function sessionRepoPath(stateDir: string, sessionId: string): string {
  return join(sessionDir(stateDir, sessionId), "repo");
}

/** The branch a session clone starts from: `origin/HEAD` or the clone's HEAD. */
async function defaultBranch(git: GitRunner, repo: string): Promise<string> {
  try {
    const ref = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: repo,
    });
    return ref.trim().replace(/^origin\//, "");
  } catch {
    const head = await git(["rev-parse", "HEAD"], { cwd: repo });
    return head.trim();
  }
}

/** Whether the branch exists on the remote of the session's own clone. */
async function branchExistsUpstream(
  git: GitRunner,
  repo: string,
  branch: string,
): Promise<boolean> {
  try {
    await git(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], {
      cwd: repo,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Clones the project clone into the session's own repo and repoints origin
 * at the upstream URL (the project clone is only a warm object cache).
 */
async function createSessionClone(
  git: GitRunner,
  projectClone: string,
  repo: string,
  repoUrl: string | undefined,
): Promise<void> {
  mkdirSync(dirname(repo), { recursive: true });
  await git(["clone", projectClone, repo], { cwd: projectClone });
  if (repoUrl !== undefined) {
    await git(["remote", "set-url", "origin", repoUrl], { cwd: repo });
  }
}

/** Worker branching: fetch upstream, then reuse the upstream branch or base a new one off the default. */
async function setupWorkerBranch(
  git: GitRunner,
  repo: string,
  branch: string,
): Promise<void> {
  await git(["fetch", "origin"], { cwd: repo });
  if (await branchExistsUpstream(git, repo, branch)) {
    // The fresh clone has no local branch, so checkout tracks origin/<branch>.
    await git(["checkout", branch], { cwd: repo });
  } else {
    const base = await defaultBranch(git, repo);
    await git(["checkout", "-B", branch, `origin/${base}`], { cwd: repo });
  }
}

async function setupReviewerCheckout(
  git: GitRunner,
  repo: string,
  prNumber: number,
): Promise<void> {
  await git(["fetch", "origin", `pull/${prNumber}/head`], { cwd: repo });
  await git(["checkout", "--detach", "FETCH_HEAD"], { cwd: repo });
}

/**
 * Fast-forwards a project clone to its upstream: the orchestrator works
 * directly in this clone, so merged work must reach it. A clone that cannot
 * fast-forward (local changes on the default branch) is logged and left
 * alone — never forced.
 */
export async function refreshProjectClone(
  git: GitRunner,
  projectClone: string,
  log?: (line: string) => void,
): Promise<void> {
  try {
    await git(["fetch", "origin"], { cwd: projectClone });
    await git(["merge", "--ff-only", "@{upstream}"], { cwd: projectClone });
  } catch (err) {
    log?.(`clone refresh skipped for ${projectClone}: ${errorMessage(err)}`);
  }
}

/** Launches pi in tmux and registers the session. Returns the record.
 *
 * The record is written before the pane is created: a crash between the two
 * steps then leaves a registered session with no pane, which the next
 * reconciliation archives (and replaces) — never an orphan pane with no
 * record for the daemon to reason about.
 */
export async function spawnPiSession(deps: SpawnDeps, options: SpawnPiOptions): Promise<Session> {
  const id = randomUUID();
  const tmuxSession = `pideck-${id}`;
  const git = deps.git ?? defaultGitRunner();

  let cwd = options.cwd;
  if (options.persona === "worker") {
    const issueNumber = options.issueNumber;
    if (issueNumber === undefined) {
      throw new Error(
        `worker spawn without an issueNumber would share the project clone at ${options.cwd}`,
      );
    }
    cwd = sessionRepoPath(deps.stateDir, id);
    try {
      await createSessionClone(git, options.cwd, cwd, options.repoUrl);
      await setupWorkerBranch(git, cwd, `pideck/issue-${issueNumber}`);
    } catch (err) {
      // The id is never reused and a half-built clone is worthless.
      rmSync(sessionDir(deps.stateDir, id), { recursive: true, force: true });
      throw err;
    }
  } else if (options.persona === "reviewer") {
    const prNumber = options.prNumber;
    if (prNumber === undefined) {
      throw new Error(
        `reviewer spawn without a prNumber would share the project clone at ${options.cwd}`,
      );
    }
    cwd = sessionRepoPath(deps.stateDir, id);
    try {
      await createSessionClone(git, options.cwd, cwd, options.repoUrl);
      await setupReviewerCheckout(git, cwd, prNumber);
    } catch (err) {
      rmSync(sessionDir(deps.stateDir, id), { recursive: true, force: true });
      throw err;
    }
  } else if (options.persona === "orchestrator") {
    await refreshProjectClone(git, cwd, deps.log);
  }

  const promptFile = join(statePaths(deps.stateDir).systemPromptsDir, `${id}.md`);
  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, options.systemPrompt, "utf8");

  // Pin pi's session storage to a path we own: the context probe reads the
  // JSONL from here without reconstructing pi's internal cwd-slug layout.
  const piSessionDir = join(statePaths(deps.stateDir).piSessionsDir, id);
  mkdirSync(piSessionDir, { recursive: true });

  const command = [
    "pi",
    "--session-dir",
    piSessionDir,
    "--append-system-prompt",
    promptFile,
    ...(options.model ? ["--model", options.model] : []),
  ];
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
  // Registered first: if the create below fails or the daemon dies first,
  // the record exists and reconciliation cleans the gap up; the reverse
  // order would leak a pane the registry cannot see.
  deps.registry.add(session);
  await deps.tmux.create(tmuxSession, {
    cwd,
    windowName: options.persona,
    command,
    env: { ...options.env, PD_SESSION_ID: id },
  });
  // A pane that is still booting swallows the first typed line; deliver only
  // once pi's chrome has settled. Bounded — see Tmux.waitReady.
  await deps.tmux.waitReady(tmuxSession);
  return session;
}

export interface ArchiveDeps {
  tmux: Tmux;
  registry: SessionRegistry;
  stateDir: string;
}

/**
 * Archives a session: captures the pane scrollback to
 * `<stateDir>/logs/<sessionId>.log`, kills the tmux session, removes the
 * session's own directory (clone included), and marks the record archived
 * (kept). A pane that is already gone skips straight to cleanup — its
 * scrollback died with it.
 */
export async function archiveSession(deps: ArchiveDeps, session: Session): Promise<Session> {
  if (await deps.tmux.isAlive(session.tmuxSession)) {
    const log = await deps.tmux.capturePane(session.tmuxSession);
    const logFile = join(statePaths(deps.stateDir).logsDir, `${session.id}.log`);
    mkdirSync(dirname(logFile), { recursive: true });
    writeFileSync(logFile, `${log}\n`, "utf8");
    await deps.tmux.kill(session.tmuxSession);
  }
  rmSync(sessionDir(deps.stateDir, session.id), { recursive: true, force: true });
  rmSync(join(statePaths(deps.stateDir).systemPromptsDir, `${session.id}.md`), { force: true });
  rmSync(join(statePaths(deps.stateDir).piSessionsDir, session.id), { recursive: true, force: true });
  return deps.registry.archive(session.id);
}

/**
 * Reconciles the registry with live tmux state. Every non-archived record
 * whose tmux session is gone is reported dead, and so is one whose pane
 * persists only because of `remain-on-exit` — the payload (pi) exited, the
 * pane is readable one last time, and the session is dead for work (its
 * captured log is preserved by the archive that follows). Records are NOT
 * archived here — the reconciler decides replacement (fresh session for the
 * same issue/PR). The shared `Session` contract carries no dead flag, so
 * deadness is reported to the caller instead of persisted; consumers can
 * re-derive it from tmux at any time.
 *
 * `pideck-*` tmux sessions with no registry record — left behind by a crash
 * mid-spawn or a lost registry write — are archived too: their pane is
 * captured to `<stateDir>/logs/<tmuxSession>.log` and the session killed, so
 * no pane outlives the daemon's knowledge of it. The archive needs a
 * `stateDir`; without one orphans are only reported.
 */
export async function reconcileWithTmux(
  registry: SessionRegistry,
  tmux: Tmux,
  options: { stateDir?: string; log?: (line: string) => void } = {},
): Promise<{ dead: Session[]; orphanTmuxSessions: string[] }> {
  const dead: Session[] = [];
  for (const session of registry.list({ archived: false })) {
    if (!(await tmux.isAlive(session.tmuxSession))) {
      dead.push(session);
      continue;
    }
    // A pane kept alive by remain-on-exit is a payload that exited; the
    // session is dead for work even though tmux still lists it.
    if (await tmux.paneDead(session.tmuxSession)) dead.push(session);
  }
  const orphanTmuxSessions: string[] = [];
  const registered = new Set(registry.all().map((session) => session.tmuxSession));
  for (const name of await tmux.listSessions()) {
    if (!name.startsWith("pideck-") || registered.has(name)) continue;
    orphanTmuxSessions.push(name);
    if (options.stateDir === undefined) continue;
    const log = await tmux.capturePane(name);
    const logFile = join(statePaths(options.stateDir).logsDir, `${name}.log`);
    mkdirSync(dirname(logFile), { recursive: true });
    writeFileSync(logFile, `${log}\n`, "utf8");
    await tmux.kill(name);
    options.log?.(`reconciler: archived orphan pane ${name} with no registry record`);
  }
  return { dead, orphanTmuxSessions };
}
