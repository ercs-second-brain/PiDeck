/**
 * Shared fakes for the self-update test files (update.test.ts,
 * update-apply.test.ts): git/gh runner doubles and a default-constructed
 * UpdateChecker — no subprocess, no network.
 */

import type { GhRunner } from "../github/gh.js";
import type { GitRunner } from "../github/repos.js";

import { UpdateChecker } from "./update.js";

const STATE_DIR = "/state";
const SRC_DIR = "/state/src";

/** Git runner fake: `rev-parse HEAD` → options.localSha (or fails), `remote get-url origin` → options.remoteUrl. */
export function fakeGit(options: { localSha?: string; remoteUrl?: string; failRevParse?: boolean } = {}): GitRunner {
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
export function fakeGh(options: { remoteSha?: string; fail?: boolean; stderr?: string } = {}): GhRunner {
  return async (args) => {
    if (args[0] !== "api" || !args[1]?.startsWith("repos/")) {
      throw new Error(`fake gh: unmatched invocation: gh ${args.join(" ")}`);
    }
    if (options.fail) throw new Error(options.stderr ?? "gh exploded");
    if (options.remoteSha === undefined) return { stdout: "{}", stderr: "" };
    return { stdout: JSON.stringify({ sha: options.remoteSha }), stderr: "" };
  };
}

export function checker(overrides: Partial<ConstructorParameters<typeof UpdateChecker>[0]> = {}): UpdateChecker {
  return new UpdateChecker({
    srcDir: SRC_DIR,
    stateDir: STATE_DIR,
    git: fakeGit({ localSha: "a".repeat(40), remoteUrl: "https://github.com/ercs-second-brain/agentsKISS.git" }),
    gh: fakeGh({ remoteSha: "a".repeat(40) }),
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    ...overrides,
  });
}

