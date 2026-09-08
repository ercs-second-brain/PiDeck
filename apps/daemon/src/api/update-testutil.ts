/**
 * Shared fakes for the self-update test files (update.test.ts,
 * update-apply.test.ts): a gh runner double (single commit endpoint) and a
 * default-constructed UpdateChecker — no subprocess, no network. The git
 * fake is the one api-layer git fake (./testutil.js), configured here for
 * the checker's `rev-parse HEAD` / `remote get-url origin` probes.
 */

import type { GhRunner } from "../github/gh.js";

import { fakeGit } from "./testutil.js";
import { UpdateChecker } from "./update.js";

const STATE_DIR = "/state";
const SRC_DIR = "/state/src";

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
    // The default remote URL is deliberately the repo's pre-rename name
    // (agentsKISS, now PiDeck): the installer records the URL it cloned
    // from in config.json, and GitHub redirects renamed repos — the check
    // must keep working off that recorded name (update.test.ts pins
    // `status.repo` echoing it verbatim).
    git: fakeGit({ localSha: "a".repeat(40), remoteUrl: "https://github.com/ercs-second-brain/agentsKISS.git" }),
    gh: fakeGh({ remoteSha: "a".repeat(40) }),
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    ...overrides,
  });
}

