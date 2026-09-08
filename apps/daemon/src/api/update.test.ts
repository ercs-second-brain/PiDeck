/**
 * Unit tests for the self-update check (issue #55): local source revision vs
 * upstream head via mock gh/git runners, the boot-captured `runningSha`
 * (issue #89: source HEAD moves mid-update, the running build does not) and
 * the status cache. The apply path lives in update-apply.test.ts.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { GhRunner } from "../github/gh.js";
import type { GitRunner } from "../github/repos.js";

import { checker, fakeGit, fakeGh } from "./update-testutil.js";
import { GhError } from "../github/gh.js";
import { withPrivateGhFallback } from "./update.js";

describe("UpdateChecker", () => {
  it("reports up-to-date when local HEAD matches the upstream head", async () => {
    const status = await checker().check();
    expect(status).toEqual({
      repo: "ercs-second-brain/agentsKISS",
      ref: "main",
      localSha: "a".repeat(40),
      remoteSha: "a".repeat(40),
      runningSha: "a".repeat(40),
      runningBehindSource: false,
      applyProgress: null,
      updateAvailable: false,
      checkedAt: "2026-01-02T03:04:05.000Z",
      error: null,
    });
  });

  it("reports an update available when the remote ref advanced", async () => {
    const status = await checker({ gh: fakeGh({ remoteSha: "b".repeat(40) }) }).check();
    expect(status.updateAvailable).toBe(true);
    expect(status.localSha).toBe("a".repeat(40));
    expect(status.remoteSha).toBe("b".repeat(40));
    expect(status.error).toBeNull();
  });

  it("resolves repo/ref from the installer config.json over git-remote fallback", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ak-update-"));
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ repoUrl: "git@github.com:some-org/private-dev.git", repoRef: "dev-branch" }),
    );
    const status = await checker({
      stateDir: dir,
      git: fakeGit({ localSha: "a".repeat(40), remoteUrl: "https://github.com/fallback/ignored" }),
      gh: fakeGh({ remoteSha: "b".repeat(40) }),
    }).check();
    expect(status.repo).toBe("some-org/private-dev");
    expect(status.ref).toBe("dev-branch");
    expect(status.updateAvailable).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the git remote and main ref without config.json", async () => {
    const status = await checker({
      git: fakeGit({ localSha: "a".repeat(40), remoteUrl: "git@github.com:dev/fork.git" }),
      gh: fakeGh({ remoteSha: "a".repeat(40) }),
    }).check();
    expect(status.repo).toBe("dev/fork");
    expect(status.ref).toBe("main");
    expect(status.updateAvailable).toBe(false);
  });

  it("explicit repoUrl/repoRef options win over config and remote", async () => {
    const status = await checker({
      repoUrl: "https://github.com/opt/explicit",
      repoRef: "release",
      gh: fakeGh({ remoteSha: "a".repeat(40) }),
    }).check();
    expect(status.repo).toBe("opt/explicit");
    expect(status.ref).toBe("release");
  });

  it("survives a missing local source (no update claimed, error explained)", async () => {
    const status = await checker({ git: fakeGit({ failRevParse: true, remoteUrl: "https://github.com/ercs-second-brain/agentsKISS.git" }) }).check();
    expect(status.localSha).toBeNull();
    expect(status.updateAvailable).toBe(false);
    expect(status.error).toContain("no local source revision");
  });

  it("survives a gh failure (remoteSha null, error set)", async () => {
    const status = await checker({ gh: fakeGh({ fail: true, stderr: "authentication required" }) }).check();
    expect(status.remoteSha).toBeNull();
    expect(status.updateAvailable).toBe(false);
    expect(status.error).toContain("authentication required");
  });

  it("flags a gh response without a sha as an error, not an update", async () => {
    const status = await checker({ gh: fakeGh({ remoteSha: undefined }) }).check();
    expect(status.remoteSha).toBeNull();
    expect(status.updateAvailable).toBe(false);
    expect(status.error).toContain("no commit sha");
  });

  it("keeps a non-GitHub upstream URL usable in the status body", async () => {
    const status = await checker({
      repoUrl: "https://example.com/some/repo.git",
      repoRef: "main",
      gh: fakeGh({ fail: true }),
    }).check();
    expect(status.repo).toBe("https://example.com/some/repo.git");
    expect(status.ref).toBe("main");
    expect(status.error).toContain("upstream check for https://example.com/some/repo.git@main failed");
  });

  it("survives a missing git repo at construction (runningSha null)", async () => {
    const status = await checker({ git: fakeGit({ failRevParse: true }) }).check();
    expect(status.runningSha).toBeNull();
  });
});

describe("UpdateChecker.runningSha (issue #89)", () => {
  /** Real state dir with an installer config so the upstream check resolves. */
  function configStateDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "ak-runningsha-"));
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ repoUrl: "https://github.com/o/r.git", repoRef: "main" }));
    return dir;
  }

  it("is captured at construction and survives a mid-update source reset", async () => {
    // The update shim resets the source checkout to the new commit BEFORE
    // rebuilding/restarting — a check-time HEAD read would mistake the new
    // commit for the running build and falsely resolve the webapp banner.
    const OLD = "1".repeat(40);
    const NEW = "2".repeat(40);
    let head = OLD;
    const git: GitRunner = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${head}\n`, stderr: "" };
      throw new Error(`fake git: unmatched invocation: git ${args.join(" ")}`);
    };
    const instance = checker({ stateDir: configStateDir(), git, gh: fakeGh({ remoteSha: NEW }) });
    const before = await instance.check();
    expect(before.runningSha).toBe(OLD);
    expect(before.localSha).toBe(OLD);
    // Simulate the shim's `git reset --hard`: HEAD moved, daemon unchanged.
    head = NEW;
    const after = await instance.check({ force: true });
    expect(after.runningSha).toBe(OLD);
    expect(after.localSha).toBe(NEW);
    // Issue #198: `updateAvailable` compares the RUNNING build against the
    // remote — mid-update the daemon still runs the old build, so the update
    // stays available until the restarted daemon reports the new runningSha
    // (that runningSha comparison is what actually resolves the banner).
    expect(after.updateAvailable).toBe(true);
    expect(after.runningBehindSource).toBe(true);
  });

  it("keeps the update available when the source matches upstream but the running build is stale (issue #198)", async () => {
    // The live failure this fixes: an apply died between the source reset
    // and the restart; the next check read localSha == remoteSha and
    // reported "up to date" while the old build kept serving.
    const OLD = "1".repeat(40);
    const NEW = "2".repeat(40);
    let head = OLD;
    const git: GitRunner = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${head}\n`, stderr: "" };
      throw new Error(`fake git: unmatched invocation: git ${args.join(" ")}`);
    };
    const instance = checker({ stateDir: configStateDir(), git, gh: fakeGh({ remoteSha: NEW }) });
    await instance.check(); // boot capture: running build = OLD
    head = NEW; // the shim's `git reset --hard` moved the source, no restart
    const stale = await instance.check({ force: true });
    expect(stale.runningSha).toBe(OLD);
    expect(stale.localSha).toBe(NEW);
    expect(stale.remoteSha).toBe(NEW);
    expect(stale.updateAvailable).toBe(true);
    expect(stale.runningBehindSource).toBe(true);
  });

  it("publishes the boot SHA to <stateDir>/var/running-sha for the update shim (issue #198)", async () => {
    const dir = configStateDir();
    await checker({ stateDir: dir }).check();
    expect(readFileSync(path.join(dir, "var", "running-sha"), "utf8")).toBe(`${"a".repeat(40)}\n`);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Status caching + detached apply (issue #76)
// ---------------------------------------------------------------------------

describe("UpdateChecker caching (issue #76)", () => {
  /** Counts gh invocations and remembers the last `now()` reading used. */
  function countingGh(remoteSha: string): { gh: GhRunner; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      gh: async (args) => {
        calls += 1;
        return fakeGh({ remoteSha })(args);
      },
    };
  }

  it("serves a cached status within the TTL instead of re-hitting gh", async () => {
    const counted = countingGh("b".repeat(40));
    let nowMs = 1_000;
    const instance = checker({ gh: counted.gh, now: () => new Date(nowMs), cacheTtlMs: 5 * 60 * 1000 });
    const first = await instance.check();
    nowMs += 60_000; // 1 minute later — still fresh
    const second = await instance.check();
    expect(second).toEqual(first); // served from cache: same gh result, same instant
    expect(counted.calls()).toBe(1);
    nowMs += 5 * 60 * 1000; // past the TTL — re-checks
    const third = await instance.check();
    expect(third).not.toBe(first);
    expect(counted.calls()).toBe(2);
    expect(third.checkedAt).toBe(new Date(nowMs).toISOString());
  });

  it("defaults to a ~5 minute TTL (issue #82)", async () => {
    const counted = countingGh("b".repeat(40));
    let nowMs = 1_000;
    const instance = checker({ gh: counted.gh, now: () => new Date(nowMs) });
    await instance.check();
    nowMs += 5 * 60 * 1000 - 1; // just inside the default TTL — still cached
    await instance.check();
    expect(counted.calls()).toBe(1);
    nowMs += 1; // past it — re-checks
    await instance.check();
    expect(counted.calls()).toBe(2);
  });

  it("force bypasses the cache (webapp ?refresh=1, issue #82)", async () => {
    const counted = countingGh("b".repeat(40));
    let nowMs = 1_000;
    const instance = checker({ gh: counted.gh, now: () => new Date(nowMs) });
    const first = await instance.check();
    nowMs += 1_000; // well within the TTL
    const forced = await instance.check({ force: true });
    expect(forced).not.toBe(first);
    expect(counted.calls()).toBe(2);
    expect(forced.checkedAt).toBe(new Date(nowMs).toISOString());
    // The forced result becomes the new cache entry.
    const second = await instance.check();
    expect(second).toEqual(forced);
    expect(counted.calls()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// gh resolution in the daemon context (issue #221)
// ---------------------------------------------------------------------------

describe("withPrivateGhFallback (issue #221)", () => {
  /** A GhError shaped like the default runner's ENOENT (gh missing on PATH). */
  const enoentError = (): GhError =>
    new GhError(["api", "repos/o/r/commits/main"], null, "", Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));

  it("uses the base runner when it resolves gh (fallback never consulted)", async () => {
    const base: GhRunner = async () => ({ stdout: "{}", stderr: "" });
    // Even a nonsense private path must not matter while the base works.
    const wrapped = withPrivateGhFallback(base, "/nonexistent/opt/gh/bin/gh");
    expect((await wrapped(["api", "x"])).stdout).toBe("{}");
  });

  it("falls back to the installer's private gh copy on ENOENT", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ak-gh-"));
    const privateGh = path.join(dir, "gh");
    writeFileSync(privateGh, '#!/bin/sh\n[ "$1" = api ] && printf \'{"sha":"private-sha"}\'\n');
    chmodSync(privateGh, 0o755);
    const wrapped = withPrivateGhFallback(async () => {
      throw enoentError();
    }, privateGh);
    const result = await wrapped(["api", "repos/o/r/commits/main"]);
    expect((JSON.parse(result.stdout) as { sha: string }).sha).toBe("private-sha");
    rmSync(dir, { recursive: true, force: true });
  });

  it("explains honestly when neither the PATH nor the private copy has gh", async () => {
    const wrapped = withPrivateGhFallback(
      async () => {
        throw enoentError();
      },
      "/nonexistent/opt/gh/bin/gh",
    );
    await expect(wrapped(["api", "x"])).rejects.toThrow(/not found on the daemon's PATH/);
  });

  it("propagates non-ENOENT failures untouched (auth errors etc.)", async () => {
    const failure = new GhError(["api", "x"], 1, "authentication required");
    const wrapped = withPrivateGhFallback(
      async () => {
        throw failure;
      },
      "/nonexistent/opt/gh/bin/gh",
    );
    await expect(wrapped(["api", "x"])).rejects.toBe(failure);
  });
});
