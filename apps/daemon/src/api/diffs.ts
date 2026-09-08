/**
 * PR diff support (list a project's pull requests with CI/review metadata,
 * fetch one PR's unified diff with per-file stats) plus per-worker
 * files-changed listing (issue #126): a worker's PR files when a PR exists,
 * or its branch's diff against the project's default branch while work is
 * still mid-flight — mapped onto the shared `PullRequestDiff` and
 * `WorkerFilesChanged` contracts.
 */

import {
  pullRequestDiffSchema,
  workerFilesChangedSchema,
  type DiffFile,
  type PullRequest,
  type PullRequestDiff,
  type Worker,
  type WorkerFilesChanged,
} from "@agentskiss/shared";

import {
  GhClient,
  GhError,
  defaultGitRunner,
  listPullRequestsWithMeta,
  mapRestPull,
  parseRepoUrl,
  type RepoRef,
} from "../github/index.js";
import type { GitRunner } from "../github/repos.js";
import { HttpError } from "./router.js";

export interface DiffServiceDeps {
  gh: (repoUrl: string) => GhClient;
  /**
   * Batched + TTL-cached open-PR listing (issue #40). Defaults to the
   * uncached REST + per-PR enrichment flow for direct constructions.
   */
  pullListing?: (projectId: string, repoUrl: string) => Promise<PullRequest[]>;
  /** Git runner for local branch discovery (worker files-changed, #126). */
  git?: GitRunner;
}

export class DiffService {
  private readonly gh: (repoUrl: string) => GhClient;
  private readonly pullListing?: (projectId: string, repoUrl: string) => Promise<PullRequest[]>;
  private readonly git: GitRunner;

  constructor(deps: DiffServiceDeps) {
    this.gh = deps.gh;
    this.pullListing = deps.pullListing;
    this.git = deps.git ?? defaultGitRunner;
  }

  /** All pull requests for a project, enriched with ciStatus/reviewState. */
  async listPullRequests(projectId: string, repoUrl: string): Promise<PullRequest[]> {
    if (this.pullListing !== undefined) return this.pullListing(projectId, repoUrl);
    return listPullRequestsWithMeta(this.gh(repoUrl), projectId, parseRepoUrl(repoUrl));
  }

  /** One PR's readable diff (`gh pr diff` + per-file stat parsing). */
  async getDiff(projectId: string, repoUrl: string, prNumber: number): Promise<PullRequestDiff> {
    const gh = this.gh(repoUrl);
    const repo = parseRepoUrl(repoUrl);
    const raw = await gh.apiJson<unknown>(`/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}`);
    const { pullRequest } = mapRestPull(projectId, raw);
    const patch = await fetchPrDiff(gh, repo, prNumber);
    return pullRequestDiffSchema.parse({
      projectId,
      prNumber,
      headBranch: pullRequest.headBranch,
      baseBranch: pullRequest.baseBranch,
      files: parseUnifiedDiff(patch),
      patch,
    });
  }

  /**
   * Files changed by one worker (issue #126). With a PR: that PR's diff
   * (`source: "pr"`). Without: the worker's checked-out branch diffed
   * against the project's default branch (`source: "branch"`) so mid-flight
   * work is inspectable before the PR exists. Works for archived workers
   * via their recorded PR/session cwd — 409 when neither is resolvable.
   */
  async getWorkerFilesChanged(
    projectId: string,
    repoUrl: string,
    input: WorkerFilesInput,
  ): Promise<WorkerFilesChanged> {
    const { worker, sessionCwd, baseBranch } = input;
    if (worker.prNumber !== null) {
      const diff = await this.getDiff(projectId, repoUrl, worker.prNumber);
      return workerFilesChangedSchema.parse({
        workerId: worker.id,
        projectId,
        source: "pr",
        prNumber: worker.prNumber,
        headBranch: diff.headBranch,
        baseBranch: diff.baseBranch,
        files: diff.files,
        patch: diff.patch,
      });
    }
    const head = await resolveWorkerHeadBranch(this.git, sessionCwd);
    if (head === null) {
      throw new HttpError(
        409,
        `worker ${worker.id} has no PR and its branch could not be resolved (no recorded checkout)`,
      );
    }
    const listing = await branchListing(this.gh(repoUrl), this.git, sessionCwd, parseRepoUrl(repoUrl), baseBranch, head);
    return workerFilesChangedSchema.parse({
      workerId: worker.id,
      projectId,
      source: "branch",
      prNumber: null,
      headBranch: head,
      baseBranch,
      ...listing,
    });
  }
}

/** Inputs for {@link DiffService.getWorkerFilesChanged} beyond project identity. */
export interface WorkerFilesInput {
  worker: Worker;
  /** Recorded cwd of the worker's session (clone or worktree), for local branch discovery. */
  sessionCwd?: string;
  /** Base branch for the branch-vs-base compare (the project's default branch). */
  baseBranch: string;
}

/** Current checked-out branch of the worker's checkout (`null` when unresolvable). */
async function resolveWorkerHeadBranch(git: GitRunner, cwd?: string): Promise<string | null> {
  if (cwd === undefined) return null;
  try {
    const { stdout } = await git(["branch", "--show-current"], { cwd });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

/** Subset of the GitHub compare API response this service consumes. */
interface GhCompareFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface GhCompareResponse {
  files?: GhCompareFile[];
}

const COMPARE_FILE_STATUSES = new Set(["added", "modified", "removed", "renamed"]);

/** Maps compare API files onto the shared `DiffFile` shape (unknown statuses read as modified). */
function mapCompareFiles(files: GhCompareFile[]): DiffFile[] {
  return files.map((file) => ({
    filename: file.filename,
    status: COMPARE_FILE_STATUSES.has(file.status) ? (file.status as DiffFile["status"]) : "modified",
    additions: file.additions,
    deletions: file.deletions,
  }));
}

/** Reassembles a renderable unified patch from the compare API's per-file patches. */
function comparePatch(files: GhCompareFile[]): string {
  return files
    .filter((file) => typeof file.patch === "string")
    .map((file) => `diff --git a/${file.filename} b/${file.filename}\n${file.patch}`)
    .join("\n");
}

/**
 * Branch-vs-base file listing (issue #126): `gh api compare` first (remote
 * truth). Mid-flight workers usually push only at PR time, so an unresolvable
 * head falls back to a local `git diff` in the worker's checkout.
 */
async function branchListing(
  gh: GhClient,
  git: GitRunner,
  cwd: string | undefined,
  repo: RepoRef,
  base: string,
  head: string,
): Promise<{ files: DiffFile[]; patch: string }> {
  try {
    const compare = await gh.apiJson<GhCompareResponse>(
      `/repos/${repo.owner}/${repo.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    const files = compare.files ?? [];
    return { files: mapCompareFiles(files), patch: comparePatch(files) };
  } catch (err) {
    if (!(err instanceof GhError) || !/404|not found/i.test(err.stderr)) throw err;
  }
  return localBranchDiff(git, cwd, repo, base, head);
}

/** Local `git diff <base>...HEAD` fallback for unpushed branches (issue #126). */
async function localBranchDiff(
  git: GitRunner,
  cwd: string | undefined,
  repo: RepoRef,
  base: string,
  head: string,
): Promise<{ files: DiffFile[]; patch: string }> {
  if (cwd === undefined) {
    throw new HttpError(
      409,
      `branch ${head} of ${repo.owner}/${repo.repo} is not on the remote yet and the worker has no recorded checkout`,
    );
  }
  for (const baseRef of [base, `origin/${base}`]) {
    try {
      const { stdout } = await git(["diff", `${baseRef}...HEAD`], { cwd });
      return { files: parseUnifiedDiff(stdout), patch: stdout };
    } catch {
      // Base ref unavailable locally — try the remote-tracking form next.
    }
  }
  throw new HttpError(409, `could not diff the worker's branch against ${base} in ${cwd} (base ref missing)`);
}

async function fetchPrDiff(gh: GhClient, repo: RepoRef, prNumber: number): Promise<string> {
  try {
    const { stdout } = await gh.exec(["pr", "diff", String(prNumber), "--repo", `${repo.owner}/${repo.repo}`]);
    return stdout;
  } catch (err) {
    if (err instanceof GhError && err.exitCode === 1) {
      // gh exits 1 with "no diff" for empty PRs; treat as empty patch.
      if (/no changes|empty/i.test(err.stderr)) return "";
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Unified diff parsing
// ---------------------------------------------------------------------------

/** Parses a unified patch into per-file stats (shared `DiffFile` shape). */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = patch.split("\n");
  let current: { file: DiffFile; inHunk: boolean } | undefined;

  const flush = (): void => {
    if (current !== undefined) files.push(current.file);
    current = undefined;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = { file: { filename: gitHeaderPath(line), status: "modified", additions: 0, deletions: 0 }, inHunk: false };
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("rename from ")) {
      current.file.status = "renamed";
      continue;
    }
    if (line.startsWith("new file mode")) {
      current.file.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.file.status = "removed";
      continue;
    }
    if (line.startsWith("@@")) {
      current.inHunk = true;
      continue;
    }
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      current.inHunk = false;
      continue;
    }
    if (!current.inHunk) continue;
    if (line.startsWith("+")) current.file.additions++;
    else if (line.startsWith("-")) current.file.deletions++;
  }
  flush();
  return files;
}

/** Extracts the repo-relative path from a `diff --git a/x b/x` header. */
function gitHeaderPath(header: string): string {
  // Format: diff --git a/<path> b/<path> (paths may be quoted when they
  // contain spaces; take the b/ side, strip a possible trailing tab).
  const match = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(header);
  const path = match?.[2] ?? header.slice("diff --git ".length).replace(/^a\/\S+\s+b\//, "");
  return path.replace(/\t$/, "");
}
