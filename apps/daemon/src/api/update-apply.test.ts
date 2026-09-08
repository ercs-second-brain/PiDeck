/**
 * Apply-path tests for the self-update (issues #76, #89, #186, #198): the
 * shim's live progress file (including the failure detail the webapp
 * surfaces), the detached spawn of the installed shim (with its apply log),
 * and the progress-cycle reset between applies. The check/caching logic
 * lives in update.test.ts.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SpawnOptions } from "node:child_process";

import { describe, expect, it } from "vitest";

import { checker } from "./update-testutil.js";
import type { GhRunner } from "../github/gh.js";
import type { GitRunner } from "../github/repos.js";

describe("UpdateChecker.applyProgress (issue #89)", () => {
  /** Real tmp state dir so the shim's progress file can actually be written. */
  function progressState(): {
    dir: string;
    write: (stage: string, updatedAt?: string, error?: string) => void;
    file: string;
  } {
    const dir = mkdtempSync(path.join(tmpdir(), "ak-progress-"));
    const file = path.join(dir, "var", "update-state.json");
    return {
      dir,
      file,
      write: (stage, updatedAt = "2026-01-02T03:00:00Z", error) => {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(error === undefined ? { stage, updatedAt } : { stage, updatedAt, error }));
      },
    };
  }

  it("serves the shim's progress file fresh even on a cache hit", async () => {
    const state = progressState();
    let nowMs = 1_000;
    const instance = checker({ stateDir: state.dir, now: () => new Date(nowMs), cacheTtlMs: 5 * 60 * 1000 });
    state.write("fetching");
    const first = await instance.check();
    expect(first.applyProgress).toEqual({ stage: "fetching", updatedAt: "2026-01-02T03:00:00Z" });
    nowMs += 60_000; // still inside the TTL — gh is not re-hit
    state.write("building");
    const second = await instance.check();
    expect(second.applyProgress).toEqual({ stage: "building", updatedAt: "2026-01-02T03:00:00Z" });
  });

  it("ignores missing and malformed progress files", async () => {
    const state = progressState();
    expect((await checker({ stateDir: state.dir }).check()).applyProgress).toBeNull();
    mkdirSync(path.dirname(state.file), { recursive: true });
    writeFileSync(state.file, "not json at all");
    expect((await checker({ stateDir: state.dir }).check()).applyProgress).toBeNull();
    writeFileSync(state.file, JSON.stringify({ stage: "building", updatedAt: "yesterday" }));
    expect((await checker({ stateDir: state.dir }).check()).applyProgress).toBeNull();
    writeFileSync(state.file, JSON.stringify({ updatedAt: "2026-01-02T03:00:00Z" }));
    expect((await checker({ stateDir: state.dir }).check()).applyProgress).toBeNull();
  });

  it("ignores stale progress (crashed shim) instead of pinning a phantom stage", async () => {
    const state = progressState();
    // checker()'s now() is 2026-01-02T03:04:05Z; 31 min old progress is stale.
    state.write("building", "2026-01-02T02:33:00Z");
    expect((await checker({ stateDir: state.dir }).check()).applyProgress).toBeNull();
    state.write("building", "2026-01-02T03:04:00Z"); // 5s old — fresh
    expect((await checker({ stateDir: state.dir }).check()).applyProgress?.stage).toBe("building");
  });

  it("carries the shim's failure detail in applyProgress.error (issue #198)", async () => {
    const state = progressState();
    state.write("failed", "2026-01-02T03:04:00Z", "systemctl --user restart pideck-daemon.service failed");
    const progress = (await checker({ stateDir: state.dir }).check()).applyProgress;
    expect(progress).toEqual({
      stage: "failed",
      updatedAt: "2026-01-02T03:04:00Z",
      error: "systemctl --user restart pideck-daemon.service failed",
    });
    // Non-failed stages must not invent an error field.
    state.write("building");
    expect((await checker({ stateDir: state.dir }).check()).applyProgress).toEqual({
      stage: "building",
      updatedAt: "2026-01-02T03:00:00Z",
    });
  });
});

// ---------------------------------------------------------------------------
// Progress liveness + apply-in-progress reporting (issue #221): a crashed
// apply's debris is cleared, and a genuinely running apply is reported
// instead of raced.
// ---------------------------------------------------------------------------

describe("UpdateChecker.applyProgress liveness (issue #221)", () => {
  function progressState(): {
    dir: string;
    write: (stage: string, updatedAt?: string, error?: string) => void;
    file: string;
  } {
    const dir = mkdtempSync(path.join(tmpdir(), "ak-progress-"));
    const file = path.join(dir, "var", "update-state.json");
    return {
      dir,
      file,
      write: (stage, updatedAt = "2026-01-02T03:00:00Z", error) => {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(error === undefined ? { stage, updatedAt } : { stage, updatedAt, error }));
      },
    };
  }

  it("clears stale progress debris so a crashed apply cannot resurface (issue #221)", async () => {
    const state = progressState();
    state.write("building", "2026-01-02T02:33:00Z"); // 31 min old — dead
    expect((await checker({ stateDir: state.dir }).check()).applyProgress).toBeNull();
    // The dead entry must be gone from disk, not just ignored: the next
    // check (and the next apply's progress cycle) starts clean.
    expect(existsSync(state.file)).toBe(false);
  });

  it("serves the last completed status with the live stage while an apply runs, without re-probing git/gh (issue #221)", async () => {
    const state = progressState();
    writeFileSync(
      path.join(state.dir, "config.json"),
      JSON.stringify({ repoUrl: "https://github.com/o/r.git", repoRef: "main" }),
    );
    const AAA = "a".repeat(40);
    const BBB = "b".repeat(40);
    let revParseCalls = 0;
    let ghCalls = 0;
    const git: GitRunner = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        revParseCalls += 1;
        return { stdout: `${AAA}\n`, stderr: "" };
      }
      throw new Error(`fake git: unmatched invocation: git ${args.join(" ")}`);
    };
    const gh: GhRunner = async () => {
      ghCalls += 1;
      return { stdout: JSON.stringify({ sha: BBB }), stderr: "" };
    };
    const instance = checker({ stateDir: state.dir, git, gh });
    const before = await instance.check({ force: true }); // primes lastBase
    const probesAfterPrime = { revParse: revParseCalls, gh: ghCalls };
    state.write("building", "2026-01-02T03:04:00Z"); // 5s old — genuinely running
    // `force: true` proves the point: even a forced check must not race the
    // shim's git/gh operations — it serves the last completed status with
    // the live stage attached instead.
    const during = await instance.check({ force: true });
    expect(during.applyProgress).toEqual({ stage: "building", updatedAt: "2026-01-02T03:04:00Z" });
    expect(during.localSha).toBe(before.localSha);
    expect(during.runningSha).toBe(before.runningSha);
    expect(revParseCalls).toBe(probesAfterPrime.revParse);
    expect(ghCalls).toBe(probesAfterPrime.gh);
    // Terminal stage (done/failed): probing resumes for the next cycle.
    state.write("done", "2026-01-02T03:04:30Z");
    const after = await instance.check({ force: true });
    expect(ghCalls).toBe(probesAfterPrime.gh + 1);
    expect(after.applyProgress?.stage).toBe("done");
  });
;
});

// ---------------------------------------------------------------------------
describe("UpdateChecker.apply (issue #76)", () => {
  /** An installed shim in a tmp state dir; returns its bin path. */
  function installedStateDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "ak-apply-"));
    mkdirSync(path.join(dir, "bin"), { recursive: true });
    writeFileSync(path.join(dir, "bin", "pideck"), "#!/bin/sh\n");
    return dir;
  }

  it("spawns the installed shim detached, logging to <stateDir>/log/update.log (issue #198)", async () => {
    const stateDir = installedStateDir();
    const spawned: Array<{ file: string; args: readonly string[]; options: SpawnOptions }> = [];
    const instance = checker({
      stateDir,
      spawn: (file, args, options) => {
        spawned.push({ file, args, options });
        return { unref() {} };
      },
    });
    await instance.apply();
    expect(spawned).toHaveLength(1);
    const spawnCall = spawned[0]!;
    expect(spawnCall.file).toBe(path.join(stateDir, "bin", "pideck"));
    expect(spawnCall.args).toEqual(["update"]);
    expect(spawnCall.options.detached).toBe(true);
    expect(spawnCall.options.cwd).toBe(stateDir);
    // stdout+stderr go to the apply log (append), so a failed apply leaves a
    // debuggable trace instead of vanishing into stdio:"ignore".
    expect(spawnCall.options.stdio).toEqual(["ignore", expect.any(Number), expect.any(Number)]);
    expect(readFileSync(path.join(stateDir, "log", "update.log"), "utf8")).toContain("apply started");
  });

  it("clears a prior apply's terminal progress before spawning the shim (issue #186)", async () => {
    // A completed (or failed) prior apply leaves its terminal stage in the
    // progress file for the TTL — the next apply's polling must never read
    // that stale outcome as its own (false done/failed).
    const stateDir = installedStateDir();
    const progressFile = path.join(stateDir, "var", "update-state.json");
    mkdirSync(path.dirname(progressFile), { recursive: true });
    writeFileSync(progressFile, JSON.stringify({ stage: "failed", updatedAt: "2026-01-02T03:00:00Z" }));
    const instance = checker({ stateDir, spawn: () => ({ unref() {} }) });
    await instance.apply();
    expect(existsSync(progressFile)).toBe(false);
  });

  it("rejects cleanly without an installed shim (dev checkout)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ak-apply-"));
    let spawned = 0;
    const instance = checker({
      stateDir: dir,
      spawn: () => {
        spawned += 1;
        return { unref() {} };
      },
    });
    await expect(instance.apply()).rejects.toThrow(/no pideck shim at .*bin\/pideck/);
    expect(spawned).toBe(0);
  });
});
