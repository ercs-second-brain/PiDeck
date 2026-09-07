/**
 * Self-update check (issue #55): compares the local source revision
 * (`git rev-parse HEAD` at the installed checkout, `$AK_HOME/src`) against
 * the upstream repo/ref through the `gh` CLI
 * (`gh api repos/:owner/:repo/commits/<ref>`), so private repos and dev refs
 * check exactly like public ones.
 *
 * The upstream repo/ref mirrors what the installer used (install/lib/source.sh):
 * the persisted `config.json` record (`repoUrl`/`repoRef`) wins, with a
 * git-remote fallback for dev checkouts without a config file.
 *
 * Webapp click-to-update (issue #76): `check()` results are cached (default
 * one hour) so webapp polling never burns gh API rate limit, and `apply()`
 * spawns the installed `agentskiss update` shim **detached** — the shim
 * rebuilds and restarts the daemon service mid-apply, so the endpoint that
 * calls it returns immediately and the webapp polls until the daemon
 * reappears reporting the new SHA. The active-worker gate lives in the
 * route handlers (apps/daemon/src/api/handlers.ts), not here.
 */

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { defaultGhRunner, parseRepoUrl, type GhRunner } from "../github/gh.js";
import { defaultGitRunner, type GitRunner } from "../github/repos.js";
import { HttpError } from "./router.js";

import type { UpdateStatus } from "@agentskiss/shared";

/** Default re-check throttle: webapp polls freely; gh is hit at most hourly. */
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

/** Injectable detached-process spawner for {@link UpdateChecker.apply} (tests). */
export type UpdateSpawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => { unref(): void };

/** Repo/ref config as persisted by the installer in `$AK_HOME/config.json`. */
interface InstallConfig {
  repoUrl?: string;
  repoRef?: string;
}

export interface UpdateCheckerOptions {
  /** Installed source checkout (default: `AGENTSKISS_SRC` or `<stateDir>/src`). */
  srcDir: string;
  /** Daemon state dir holding the installer's `config.json`. */
  stateDir: string;
  /** Explicit upstream repo URL (tests); else config.json → git remote. */
  repoUrl?: string;
  /** Explicit upstream ref (tests); else config.json → `main`. */
  repoRef?: string;
  /** Injectable gh runner (tests); default spawns the real `gh`. */
  gh?: GhRunner;
  /** Injectable git runner (tests); default spawns the real `git`. */
  git?: GitRunner;
  /** Re-check throttle in ms; a fresh cached status is reused within it (tests; default 1h). */
  cacheTtlMs?: number;
  /** Injectable detached spawner for `apply` (tests); default node `spawn`. */
  spawn?: UpdateSpawn;
  /** Injectable clock (tests). */
  now?: () => Date;
}

interface CachedStatus {
  status: UpdateStatus;
  /** `now()` reading when the check ran (ms epoch). */
  at: number;
}

export class UpdateChecker {
  private readonly srcDir: string;
  private readonly stateDir: string;
  private readonly repoUrl?: string;
  private readonly repoRef?: string;
  private readonly gh: GhRunner;
  private readonly git: GitRunner;
  private readonly cacheTtlMs: number;
  private readonly spawn: UpdateSpawn;
  private readonly now: () => Date;
  /** Last check result within the TTL — webapp polling must not re-hit gh. */
  private cache: CachedStatus | undefined;

  constructor(options: UpdateCheckerOptions) {
    this.srcDir = options.srcDir;
    this.stateDir = options.stateDir;
    this.repoUrl = options.repoUrl;
    this.repoRef = options.repoRef;
    this.gh = options.gh ?? defaultGhRunner;
    this.git = options.git ?? defaultGitRunner;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.spawn = options.spawn ?? nodeSpawn;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Runs one check, served from cache while fresh (issue #76: the webapp
   * polls this; gh may be consulted at most ~hourly). Never throws:
   * failures surface in `error` with `updateAvailable: false`, so the
   * webapp/CLI always get a well-formed status body.
   */
  async check(): Promise<UpdateStatus> {
    const cached = this.cache;
    if (cached !== undefined && this.now().getTime() - cached.at < this.cacheTtlMs) {
      return cached.status;
    }
    const status = await this.runCheck();
    this.cache = { status, at: this.now().getTime() };
    return status;
  }

  /**
   * Applies a pending update (issue #76) by spawning the installed
   * `agentskiss update` shim detached — the daemon restarts mid-apply, so
   * callers return immediately after this resolves. The active-worker gate
   * is the caller's responsibility (handlers.ts), so a worker that became
   * active between check and apply is rejected before this runs.
   */
  async apply(): Promise<void> {
    const shim = `${this.stateDir}/bin/agentskiss`;
    if (!existsSync(shim)) {
      throw new HttpError(
        409,
        `no agentskiss shim at ${shim} — click-to-update needs an installed agentskiss (dev checkouts apply via the CLI)`,
      );
    }
    // Detached + unref'd: the shim outlives this process (the service
    // restart kills the daemon mid-apply, on purpose).
    this.spawn(shim, ["update"], { detached: true, stdio: "ignore", cwd: this.stateDir }).unref();
  }

  private async runCheck(): Promise<UpdateStatus> {
    const checkedAt = this.now().toISOString();
    let localSha: string | null = null;
    let remoteSha: string | null = null;
    const errors: string[] = [];

    // Local revision (independent of the remote check).
    try {
      localSha = (await this.git(["rev-parse", "HEAD"], { cwd: this.srcDir })).stdout.trim() || null;
    } catch (err) {
      errors.push(`no local source revision at ${this.srcDir}: ${errorMessage(err)}`);
    }

    // Upstream repo/ref resolution + remote head via `gh api`.
    const upstream = await this.upstreamConfig();
    const repo = upstream.repo;
    const ref = upstream.ref;
    if (upstream.error !== undefined) {
      errors.push(upstream.error);
    } else {
      try {
        const { stdout } = await this.gh(["api", `repos/${repo}/commits/${ref}`]);
        remoteSha = (JSON.parse(stdout) as { sha?: unknown }).sha as string | null;
        if (typeof remoteSha !== "string" || remoteSha.length === 0) {
          remoteSha = null;
          errors.push(`gh api returned no commit sha for ${repo}@${ref}`);
        }
      } catch (err) {
        errors.push(`upstream check for ${repo}@${ref} failed: ${errorMessage(err)}`);
      }
    }

    return {
      repo,
      ref,
      localSha,
      remoteSha,
      updateAvailable: localSha !== null && remoteSha !== null && localSha !== remoteSha,
      checkedAt,
      error: errors.length > 0 ? errors.join("; ") : null,
    };
  }

  /** Resolves the upstream coordinates for display even when gh is unusable. */
  private async upstreamConfig(): Promise<{ repo: string; ref: string; error?: string }> {
    let repoUrl = this.repoUrl;
    let ref = this.repoRef;
    const errors: string[] = [];

    if (repoUrl === undefined || ref === undefined) {
      const config = await this.readInstallConfig();
      if (config.error !== undefined) errors.push(config.error);
      repoUrl ??= config.repoUrl;
      ref ??= config.repoRef;
    }
    if (repoUrl === undefined) {
      try {
        repoUrl = (await this.git(["remote", "get-url", "origin"], { cwd: this.srcDir })).stdout.trim() || undefined;
      } catch {
        // handled below (no upstream resolvable)
      }
    }
    ref ??= "main";

    if (repoUrl === undefined || repoUrl.length === 0) {
      const error = errors.join("; ") || "no upstream configured (no config.json, env override, or git remote)";
      return { repo: "unknown", ref, error };
    }
    try {
      const { owner, repo } = parseRepoUrl(repoUrl);
      return { repo: `${owner}/${repo}`, ref };
    } catch {
      // Non-GitHub or malformed URL — still report something meaningful.
      return { repo: repoUrl, ref };
    }
  }

  /** Reads the installer's `$AK_HOME/config.json` (best effort). */
  private async readInstallConfig(): Promise<InstallConfig & { error?: string }> {
    try {
      const raw = await readFile(`${this.stateDir}/config.json`, "utf8");
      const parsed = JSON.parse(raw) as InstallConfig;
      return {
        ...(parsed.repoUrl === undefined ? {} : { repoUrl: parsed.repoUrl }),
        ...(parsed.repoRef === undefined ? {} : { repoRef: parsed.repoRef }),
      };
    } catch (err) {
      return { error: `could not read install config: ${errorMessage(err)}` };
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
