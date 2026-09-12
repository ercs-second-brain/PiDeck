/**
 * Self-update: compares the installed checkout's HEAD with the upstream ref
 * (via `gh`) and applies an update by spawning the installed shim's
 * `pideck update`, which fetches, rebuilds and restarts the service. Passive
 * checks are cached for about an hour so the web banner never hammers the
 * network; an explicit check (the settings button, the banner's periodic
 * re-check) bypasses the cache. The reported version is the upstream short
 * SHA plus the ref's age, enough to decide whether the update matters.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UpdateCheckSchema, type UpdateCheck } from "@pideck/shared";
import type { SessionRegistry } from "../sessions/registry.js";
import { parseRepoUrl, runCommand, type CommandRunner } from "../store/projectStore.js";
import { ApiError } from "./router.js";

/** How long a passive check is served from cache. */
const CACHE_TTL_MS = 60 * 60 * 1000;
const SHORT_SHA = 7;
const MINUTE_MS = 60 * 1000;

export type UpdateRunner = CommandRunner;

export interface UpdaterConfig {
  /** The source checkout the daemon is running from. */
  srcDir: string;
  /** The install's config.json (repoUrl/repoRef); may not exist in dev checkouts. */
  configJson?: string;
  registry: SessionRegistry;
  run?: UpdateRunner;
  /** Spawns the given command detached; tests record instead of exec'ing. */
  spawn?: (cmd: string, args: string[]) => void;
  now?: () => number;
}

interface RepoConfig {
  url: string;
  ref: string;
}

export interface Updater {
  check(force?: boolean): UpdateCheck;
  apply(): { ok: true };
}

/** Reads repoUrl/repoRef from the install's config.json, if present. */
function readRepoConfig(configJson: string | undefined): RepoConfig | null {
  if (configJson === undefined || !existsSync(configJson)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configJson, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const url = (raw as { repoUrl?: unknown }).repoUrl;
  if (typeof url !== "string" || url.trim() === "") return null;
  const ref = (raw as { repoRef?: unknown }).repoRef;
  return { url, ref: typeof ref === "string" && ref.trim() !== "" ? ref : "main" };
}

function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA);
}

/** The upstream ref's age in coarse units, or null when the date is unusable. */
function refAge(committedAt: string, at: number): string | null {
  const committed = Date.parse(committedAt);
  if (Number.isNaN(committed)) return null;
  const minutes = Math.max(0, Math.floor((at - committed) / MINUTE_MS));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h old`;
  return `${Math.floor(hours / 24)} d old`;
}

function describeVersion(sha: string, committedAt: string | null, at: number): string {
  const age = committedAt === null ? null : refAge(committedAt, at);
  return age === null ? shortSha(sha) : `${shortSha(sha)} · ${age}`;
}

export function createUpdater(config: UpdaterConfig): Updater {
  const run = config.run ?? runCommand;
  const now = config.now ?? Date.now;
  const spawnUpdate =
    config.spawn ??
    ((cmd: string, args: string[]) => {
      nodeSpawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
    });

  let cache: { at: number; check: UpdateCheck } | null = null;

  function localHeadSha(): string {
    return run("git", ["rev-parse", "HEAD"], config.srcDir).stdout.trim();
  }

  function repoConfig(): RepoConfig {
    const fromInstall = readRepoConfig(config.configJson);
    if (fromInstall) return fromInstall;
    const url = run("git", ["remote", "get-url", "origin"], config.srcDir).stdout.trim();
    if (url === "") {
      throw new Error(`no upstream configured: no config.json and no git remote at ${config.srcDir}`);
    }
    return { url, ref: "main" };
  }

  function upstreamCommit(repo: RepoConfig): { sha: string; committedAt: string | null } {
    const { owner, repo: name } = parseRepoUrl(repo.url);
    const out = run("gh", [
      "api",
      `repos/${owner}/${name}/commits/${repo.ref}`,
      "--jq",
      '.sha + " " + (.commit.committer.date // "")',
    ]).stdout.trim();
    const [sha = "", committedAt = ""] = out.split(" ");
    return { sha, committedAt: committedAt === "" ? null : committedAt };
  }

  function check(force = false): UpdateCheck {
    const at = now();
    if (!force && cache !== null && at - cache.at < CACHE_TTL_MS) return cache.check;
    const localSha = localHeadSha();
    const { sha: remoteSha, committedAt } = upstreamCommit(repoConfig());
    if (localSha === "" || remoteSha === "") {
      throw new Error("could not compare the checkout with the upstream ref");
    }
    const parsed = UpdateCheckSchema.parse({
      updateAvailable: localSha !== remoteSha,
      latestVersion: describeVersion(remoteSha, committedAt, at),
    });
    cache = { at, check: parsed };
    return parsed;
  }

  function apply(): { ok: true } {
    const live = [
      ...config.registry.list({ persona: "worker", archived: false }),
      ...config.registry.list({ persona: "reviewer", archived: false }),
    ];
    if (live.length > 0) {
      throw new ApiError(409, "workers or reviewers are live — wait for them to finish, then update");
    }
    const shim = process.env.PD_HOME ? join(process.env.PD_HOME, "bin", "pideck") : "pideck";
    spawnUpdate(shim, ["update"]);
    return { ok: true };
  }

  return { check, apply };
}
