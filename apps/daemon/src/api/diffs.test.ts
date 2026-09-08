/**
 * Unit tests for the unified-diff parser backing `PullRequestDiff.files`,
 * DiffService wiring against the fake gh runner, and the per-worker
 * files-changed listing (issue #126): PR files when the worker has a PR,
 * `gh` compare for pushed branches, and a local `git diff` fallback for
 * branches that are not pushed yet.
 */

import { describe, expect, it } from "vitest";
import type { Worker } from "@pideck/shared";

import { GhClient, GhError, type GhRunner } from "../github/gh.js";
import type { GitRunner } from "../github/repos.js";
import { DiffService, parseUnifiedDiff } from "./diffs.js";
import { HttpError } from "./router.js";

const SAMPLE = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "+const b = 2;",
  "-const c = 3;",
  " const d = 4;",
  "diff --git a/src/removed.ts b/src/removed.ts",
  "deleted file mode 100644",
  "--- a/src/removed.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-export const gone = true;",
  "diff --git a/src/added.ts b/src/added.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/added.ts",
  "@@ -0,0 +1,2 @@",
  "+export const added = 1;",
  "+export const added2 = 2;",
  "diff --git a/src/before.ts b/src/after.ts",
  "similarity index 90%",
  "rename from src/before.ts",
  "rename to src/after.ts",
  "--- a/src/before.ts",
  "+++ b/src/after.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/blob.bin b/blob.bin",
  "index 111..222 100644",
  "Binary files a/blob.bin and b/blob.bin differ",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("extracts per-file status and +/- counts", () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files).toEqual([
      { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1 },
      { filename: "src/removed.ts", status: "removed", additions: 0, deletions: 1 },
      { filename: "src/added.ts", status: "added", additions: 2, deletions: 0 },
      { filename: "src/after.ts", status: "renamed", additions: 1, deletions: 1 },
      { filename: "blob.bin", status: "modified", additions: 0, deletions: 0 },
    ]);
  });

  it("returns an empty list for an empty patch", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("does not count +++/--- header lines as changes", () => {
    const files = parseUnifiedDiff(
      ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "+one", "-two", ""].join("\n"),
    );
    expect(files[0]).toEqual({ filename: "x", status: "modified", additions: 1, deletions: 1 });
  });
});

// ---------------------------------------------------------------------------
// Worker files-changed (issue #126)
// ---------------------------------------------------------------------------

const REPO_URL = "https://github.com/o/r";

const PR_PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "+const b = 2;",
  "",
].join("\n");

const PULL_9 = {
  number: 9,
  title: "Fix the flaky test",
  state: "open",
  merged_at: null,
  user: { login: "worker" },
  head: { ref: "ao/fix-flaky", sha: "abc123" },
  base: { ref: "main" },
  html_url: "https://github.com/o/r/pull/9",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const COMPARE_FILES = [
  { filename: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" },
  { filename: "src/new.ts", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+one\n+two" },
  { filename: "blob.bin", status: "modified", additions: 0, deletions: 0 },
];

function worker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: "worker-abc123",
    projectId: "o-r",
    sessionId: "sess-1",
    issueNumber: 5,
    prNumber: null,
    status: "running",
    statusMessage: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** GhRunner over a REST route table; entries may be plain payloads or GhError stderr. */
function fakeGhApi(api: Record<string, unknown>, errors: Record<string, string> = {}): GhRunner {
  return async (args: string[]) => {
    if (args[0] === "pr" && args[1] === "diff") return { stdout: PR_PATCH, stderr: "" };
    const path = args[1] ?? "";
    if (path in errors) throw new GhError(args, 1, errors[path] ?? "");
    if (path in api) return { stdout: JSON.stringify(api[path]), stderr: "" };
    throw new Error(`fake gh: unmatched invocation: gh ${args.join(" ")}`);
  };
}

interface GitCall {
  args: string[];
  cwd?: string;
}

/** GitRunner serving scripted outputs and recording every call. */
function fakeGit(outputs: Record<string, string>) {
  const calls: GitCall[] = [];
  const runner: GitRunner = async (args, options) => {
    calls.push({ args, ...(options?.cwd === undefined ? {} : { cwd: options.cwd }) });
    const key = args.join(" ");
    if (key in outputs) return { stdout: outputs[key] ?? "", stderr: "" };
    throw new Error(`fake git: unmatched invocation: git ${key}`);
  };
  return { calls, runner };
}

function service(runner: GhRunner, git?: GitRunner): DiffService {
  return new DiffService({ gh: () => new GhClient(runner), ...(git === undefined ? {} : { git }) });
}

describe("DiffService.getWorkerFilesChanged", () => {
  it("serves the worker's PR files when a PR is recorded", async () => {
    const diff = await service(fakeGhApi({ "/repos/o/r/pulls/9": PULL_9 })).getWorkerFilesChanged("o-r", REPO_URL, {
      worker: worker({ prNumber: 9 }),
      baseBranch: "main",
    });
    expect(diff).toMatchObject({
      workerId: "worker-abc123",
      projectId: "o-r",
      source: "pr",
      prNumber: 9,
      headBranch: "ao/fix-flaky",
      baseBranch: "main",
    });
    expect(diff.files).toEqual([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0 }]);
    expect(diff.patch).toBe(PR_PATCH);
  });

  it("lists branch-vs-base files via gh compare when no PR exists yet", async () => {
    const git = fakeGit({ "branch --show-current": "ao/fix-flaky\n" });
    const diff = await service(
      fakeGhApi({ "/repos/o/r/compare/main...ao%2Ffix-flaky": { files: COMPARE_FILES } }),
      git.runner,
    ).getWorkerFilesChanged("o-r", REPO_URL, { worker: worker(), sessionCwd: "/wt", baseBranch: "main" });
    expect(diff.source).toBe("branch");
    expect(diff.prNumber).toBeNull();
    expect(diff.headBranch).toBe("ao/fix-flaky");
    expect(diff.files).toEqual([
      { filename: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
      { filename: "src/new.ts", status: "added", additions: 2, deletions: 0 },
      { filename: "blob.bin", status: "modified", additions: 0, deletions: 0 },
    ]);
    // Binary files (no per-file patch) keep their stats but render no section.
    expect(diff.patch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(diff.patch).toContain("diff --git a/src/new.ts b/src/new.ts");
    expect(diff.patch).not.toContain("blob.bin");
    // Branch discovery ran in the worker's recorded checkout.
    expect(git.calls[0]?.cwd).toBe("/wt");
  });

  it("falls back to a local git diff when the branch is not pushed yet", async () => {
    const localPatch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new";
    const git = fakeGit({
      "branch --show-current": "ao/fix-flaky\n",
      "diff origin/main...HEAD": localPatch,
    });
    const diff = await service(
      fakeGhApi({}, { "/repos/o/r/compare/main...ao%2Ffix-flaky": "gh: Not Found (HTTP 404)" }),
      git.runner,
    ).getWorkerFilesChanged("o-r", REPO_URL, { worker: worker(), sessionCwd: "/wt", baseBranch: "main" });
    expect(diff.source).toBe("branch");
    expect(diff.files).toEqual([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 1 }]);
    expect(diff.patch).toBe(localPatch);
    // The base branch was tried before its remote-tracking form.
    expect(git.calls.map((call) => call.args.join(" "))).toEqual([
      "branch --show-current",
      "diff main...HEAD",
      "diff origin/main...HEAD",
    ]);
  });

  it("409s when the worker has no PR and its branch cannot be resolved", async () => {
    const git = fakeGit({});
    const svc = service(
      fakeGhApi({}, { "/repos/o/r/compare/main...ao%2Ffix-flaky": "gh: Not Found (HTTP 404)" }),
      git.runner,
    );
    await expect(
      svc.getWorkerFilesChanged("o-r", REPO_URL, { worker: worker(), sessionCwd: "/wt", baseBranch: "main" }),
    ).rejects.toMatchObject({ name: "HttpError", statusCode: 409 });
    // Without a recorded checkout there is nothing to diff locally either.
    await expect(
      service(fakeGhApi({}, { "/repos/o/r/compare/main...ao%2Ffix-flaky": "gh: Not Found (HTTP 404)" })).getWorkerFilesChanged(
        "o-r",
        REPO_URL,
        { worker: worker(), baseBranch: "main" },
      ),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("409s when the worker sits on the default branch without a checkout to diff", async () => {
    // compare 404 + git diff fails for both base refs → unresolvable.
    const git = fakeGit({ "branch --show-current": "main\n" });
    const svc = service(
      fakeGhApi({}, { "/repos/o/r/compare/main...main": "gh: Not Found (HTTP 404)" }),
      git.runner,
    );
    await expect(
      svc.getWorkerFilesChanged("o-r", REPO_URL, { worker: worker(), sessionCwd: "/wt", baseBranch: "main" }),
    ).rejects.toMatchObject({ name: "HttpError", statusCode: 409 });
  });
});
