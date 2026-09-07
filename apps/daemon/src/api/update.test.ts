/**
 * Unit tests for the self-update check (issue #55): local source revision vs
 * upstream head via mock gh/git runners — no subprocess, no network.
 */

import { describe, expect, it } from "vitest";
import type { GhRunner } from "../github/gh.js";
import type { GitRunner } from "../github/repos.js";

import { UpdateChecker } from "./update.js";

const STATE_DIR = "/state";
const SRC_DIR = "/state/src";

/** Git runner fake: `rev-parse HEAD` → options.localSha (or fails), `remote get-url origin` → options.remoteUrl. */
function fakeGit(options: { localSha?: string; remoteUrl?: string; failRevParse?: boolean } = {}): GitRunner {
  return async (args) => {
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      if (options.failRevParse || options.localSha === undefined) {
        throw new Error(`git ${args.join(" ")} failed`);
      }
      return { stdout: `${options.localSha}\n`, stderr: "" };
    }
    if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
      if (options.remoteUrl === undefined) throw new Error(`git ${args.join(" ")} failed`);
      return { stdout: `${options.remoteUrl}\n`, stderr: "" };
    }
    throw new Error(`fake git: unmatched invocation: git ${args.join(" ")}`);
  };
}

/** Gh runner fake answering `gh api repos/:owner/:repo/commits/:ref` with options.remoteSha. */
function fakeGh(options: { remoteSha?: string; fail?: boolean; stderr?: string } = {}): GhRunner {
  return async (args) => {
    if (args[0] !== "api" || !args[1]?.startsWith("repos/")) {
      throw new Error(`fake gh: unmatched invocation: gh ${args.join(" ")}`);
    }
    if (options.fail) throw new Error(options.stderr ?? "gh exploded");
    if (options.remoteSha === undefined) return { stdout: "{}", stderr: "" };
    return { stdout: JSON.stringify({ sha: options.remoteSha }), stderr: "" };
  };
}

function checker(overrides: Partial<ConstructorParameters<typeof UpdateChecker>[0]> = {}): UpdateChecker {
  return new UpdateChecker({
    srcDir: SRC_DIR,
    stateDir: STATE_DIR,
    git: fakeGit({ localSha: "a".repeat(40), remoteUrl: "https://github.com/ercs-second-brain/agentsKISS.git" }),
    gh: fakeGh({ remoteSha: "a".repeat(40) }),
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    ...overrides,
  });
}

describe("UpdateChecker", () => {
  it("reports up-to-date when local HEAD matches the upstream head", async () => {
    const status = await checker().check();
    expect(status).toEqual({
      repo: "ercs-second-brain/agentsKISS",
      ref: "main",
      localSha: "a".repeat(40),
      remoteSha: "a".repeat(40),
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
    const realFs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await realFs.mkdtemp(path.join(os.tmpdir(), "ak-update-"));
    await realFs.writeFile(
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
    await realFs.rm(dir, { recursive: true, force: true });
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
});
