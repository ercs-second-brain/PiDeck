import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * The throwaway fixture repo: created private as `<owner>/pideck-e2e-<ts>`
 * from `tools/e2e/fixture/`, pushed once as the primary account, deleted on
 * pass. The git identity in the throwaway clone is local to the clone;
 * pushes run through the primary `gh` credential helper.
 */

export async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "pideck-e2e-"));
  return {
    root,
    state: join(root, "state"),
    daemonLog: join(root, "daemon.log"),
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function git(cwd, args) {
  await execFileP("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}

export async function createRepo(fixtureSrc, repoFull, description) {
  await execFileP("gh", ["repo", "create", repoFull, "--private", "--description", description]);

  const work = mkdtempSync(join(tmpdir(), "pideck-fixture-"));
  cpSync(fixtureSrc, work, { recursive: true });
  await git(work, ["init", "-b", "main"]);
  await git(work, ["config", "user.name", "PiDeck E2E"]);
  await git(work, ["config", "user.email", "e2e@pideck.invalid"]);
  await git(work, ["add", "-A"]);
  await git(work, ["commit", "-m", "fixture: greeting, one failing test, CI"]);
  await git(work, ["remote", "add", "origin", `https://github.com/${repoFull}.git`]);
  await git(work, ["push", "-u", "origin", "main"]);
  rmSync(work, { recursive: true, force: true });
}

export async function deleteRepo(repoFull) {
  await execFileP("gh", ["repo", "delete", repoFull, "--yes"]);
}
