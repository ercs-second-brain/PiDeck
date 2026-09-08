/**
 * Repository operations: clone an existing git URL into a project directory,
 * or create a brand-new GitHub repo via `gh` (private by default, explicit
 * public toggle — PRD requirement).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AccessibleRepo } from "@pideck/shared";

import { GhClient, parseRepoUrl } from "./gh.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// git clone
// ---------------------------------------------------------------------------

export interface GitRunResult {
  stdout: string;
  stderr: string;
}

/** Executes `git <args...>`; rejects on non-zero exit. */
export type GitRunner = (args: string[], options?: { cwd?: string }) => Promise<GitRunResult>;

/** Error raised when a git invocation fails. */
export class GitError extends Error {
  override readonly name = "GitError";
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: string[], exitCode: number | null, stderr: string) {
    super(`git command failed (exit ${exitCode ?? "?"}): git ${args.join(" ")}\n${stderr.trim()}`);
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

interface GitExecError extends Error {
  code?: number | string;
  stderr?: string;
}

/** Default {@link GitRunner}: spawns the real `git` binary. */
export const defaultGitRunner: GitRunner = async (args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as GitExecError;
    throw new GitError(args, typeof e.code === "number" ? e.code : null, e.stderr ?? "");
  }
};

export interface CloneOptions {
  /** Only fetch a single branch (default: clone the default branch). */
  branch?: string;
  /** Shallow clone depth. */
  depth?: number;
}

export interface CloneResult {
  /** Absolute path the repo was cloned into. */
  destDir: string;
  repoUrl: string;
}

/**
 * Clones a git URL into `destDir` using `git clone`.
 * Fails (via git) when `destDir` already exists and is not empty.
 */
export async function cloneRepo(git: GitRunner, repoUrl: string, destDir: string, options: CloneOptions = {}): Promise<CloneResult> {
  const args = ["clone"];
  if (options.branch !== undefined) args.push("--branch", options.branch);
  if (options.depth !== undefined) args.push("--depth", String(options.depth));
  args.push(repoUrl, destDir);
  try {
    await git(args);
  } catch (err) {
    if (err instanceof GitError) throw err;
    const e = err as GitExecError;
    throw new GitError(args, typeof e.code === "number" ? e.code : null, e.stderr ?? "");
  }
  return { destDir, repoUrl };
}

// ---------------------------------------------------------------------------
// gh repo list (issue #217)
// ---------------------------------------------------------------------------

/**
 * Lists the repositories the authenticated gh user owns (issue #217):
 * `gh repo list --json name,owner,isPrivate`. Scope decision: **user-owned
 * repos only** — `gh repo list` defaults to the authenticated account, so
 * no extra flags and no org pagination; the onboarding selector stays simple.
 */
export async function listAccessibleRepos(gh: GhClient, limit = 200): Promise<AccessibleRepo[]> {
  const { stdout } = await gh.exec(["repo", "list", "--limit", String(limit), "--json", "name,owner,isPrivate"]);
  const parsed = JSON.parse(stdout) as Array<{ name: string; owner: { login: string }; isPrivate: boolean }>;
  return parsed.map((repo) => ({ owner: repo.owner.login, name: repo.name, isPrivate: repo.isPrivate }));
}

// ---------------------------------------------------------------------------
// gh repo create
// ---------------------------------------------------------------------------

export interface CreateRepoOptions {
  /**
   * Repository name, optionally `owner/name` to create under a specific
   * account/org. Plain names are created under the authenticated user.
   */
  name: string;
  /**
   * Visibility. **Defaults to `true` (private)** — PRD: created repos must
   * not be public unless explicitly requested.
   */
  isPrivate?: boolean;
  description?: string;
}

export interface CreatedRepo {
  /** https URL of the new repository. */
  url: string;
  owner: string;
  repo: string;
  isPrivate: boolean;
}

/**
 * Creates a new repository via `gh repo create`. Private by default; pass
 * `{ isPrivate: false }` for a public repo. The resulting visibility is
 * verified with a follow-up API call so the returned value is authoritative.
 */
export async function createRepo(gh: GhClient, options: CreateRepoOptions): Promise<CreatedRepo> {
  const isPrivate = options.isPrivate ?? true;
  const args = ["repo", "create", options.name, isPrivate ? "--private" : "--public"];
  if (options.description !== undefined) args.push("--description", options.description);

  const { stdout } = await gh.exec(args);
  // `gh repo create <name>` prints the new repo's https URL on success.
  const url = stdout.trim().split("\n").pop()?.trim() ?? "";
  const ref = parseRepoUrl(url);
  // Verify visibility and canonical URL against the API.
  const remote = await gh.apiJson<{ html_url: string; private: boolean; owner: { login: string }; name: string }>(
    `/repos/${ref.owner}/${ref.repo}`,
  );
  return { url: remote.html_url, owner: remote.owner.login, repo: remote.name, isPrivate: remote.private };
}


