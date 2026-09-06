/**
 * PR diff support: list a project's pull requests (with CI/review metadata)
 * and fetch one PR's unified diff with per-file stats, mapped onto the
 * shared `PullRequestDiff` contract.
 */

import {
  pullRequestDiffSchema,
  type DiffFile,
  type PullRequest,
  type PullRequestDiff,
} from "@agentskiss/shared";

import {
  GhClient,
  GhError,
  listPullRequestsWithMeta,
  mapRestPull,
  parseRepoUrl,
  type RepoRef,
} from "../github/index.js";

export interface DiffServiceDeps {
  gh: (repoUrl: string) => GhClient;
  /**
   * Batched + TTL-cached open-PR listing (issue #40). Defaults to the
   * uncached REST + per-PR enrichment flow for direct constructions.
   */
  pullListing?: (projectId: string, repoUrl: string) => Promise<PullRequest[]>;
}

export class DiffService {
  private readonly gh: (repoUrl: string) => GhClient;
  private readonly pullListing?: (projectId: string, repoUrl: string) => Promise<PullRequest[]>;

  constructor(deps: DiffServiceDeps) {
    this.gh = deps.gh;
    this.pullListing = deps.pullListing;
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
