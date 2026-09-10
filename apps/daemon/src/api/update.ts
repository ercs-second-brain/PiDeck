/**
 * Self-update check (issue #55): compares the local source revision
 * (`git rev-parse HEAD` at the installed checkout, `~/.pideck/src`) against
 * the upstream repo/ref through the `gh` CLI
 * (`gh api repos/:owner/:repo/commits/<ref>`), so private repos and dev refs
 * check exactly like public ones.
 *
 * The upstream repo/ref mirrors what the installer used (install/lib/source.sh):
 * the persisted `config.json` record (`repoUrl`/`repoRef`) wins, with a
 * git-remote fallback for dev checkouts without a config file.
 *
 * Webapp click-to-update (issue #76): `check()` results are cached (default
 * ~5 minutes, issue #82) so webapp polling never burns gh API rate limit, and
 * `apply()`
 * spawns the installed `pideck update` shim **detached** — the shim
 * rebuilds and restarts the daemon service mid-apply, so the endpoint that
 * calls it returns immediately and the webapp polls until the daemon
 * reappears reporting the new SHA. The active-worker gate lives in the
 * route handlers (apps/daemon/src/api/handlers.ts), not here.
 */

import { execFile, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { defaultGhRunner, GhError, parseRepoUrl, type GhRunner } from "../github/gh.js";
import { defaultGitRunner, type GitRunner } from "../github/repos.js";
import { TtlSwrCache } from "./swr-cache.js";
import { HttpError } from "./router.js";

import { isTerminalUpdateStage, type UpdateStatus } from "@pideck/shared";

/**
 * Default re-check throttle (issue #82): the webapp forces fresh checks on
 * page load / window focus (`?refresh=1`), while its background poll hits the
 * cache — gh is still consulted at most ~every 5 minutes server-side.
 */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * The update shim's live progress file (issue #89), relative to the state
 * dir — install/lib/update.sh rewrites it at each stage of the apply
 * (checking/fetching/building/installing/restarting/done/failed).
 */
const PROGRESS_FILE = "var/update-state.json";
/** Progress older than this is stale (crashed/killed shim) — report none. */
const PROGRESS_TTL_MS = 30 * 60 * 1000;
/** The shim writes `date -u +%Y-%m-%dT%H:%M:%SZ` — no sub-second precision. */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const execFileAsync = promisify(execFile);

/** Injectable detached-process spawner for {@link UpdateChecker.apply} (tests). */
export type UpdateSpawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => { unref(): void };

/** Repo/ref config as persisted by the installer in `~/.pideck/config.json`. */
interface InstallConfig {
  repoUrl?: string;
  repoRef?: string;
}

export interface UpdateCheckerOptions {
  /** Installed source checkout (default: `PD_SRC` or `<stateDir>/src`). */
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
  /** Re-check throttle in ms; a fresh cached status is reused within it (tests; default 5 min). */
  cacheTtlMs?: number;
  /** Injectable detached spawner for `apply` (tests); default node `spawn`. */
  spawn?: UpdateSpawn;
  /** Injectable clock (tests). */
  now?: () => Date;
}

/** Single-entry cache key ({@link UpdateChecker} caches one daemon-wide status). */
const CHECK_KEY = "update-status";

export class UpdateChecker {
  private readonly srcDir: string;
  private readonly stateDir: string;
  private readonly repoUrl?: string;
  private readonly repoRef?: string;
  private readonly gh: GhRunner;
  private readonly git: GitRunner;
  private readonly spawn: UpdateSpawn;
  private readonly now: () => Date;
  /**
   * Last check result within the TTL — webapp polling must not re-hit gh.
   * Throttle mode (`swr: false`, #131): past the TTL callers wait for a
   * fresh check instead of being served a stale status, so `checkedAt` and
   * `updateAvailable` are never knowingly outdated. All cache mechanics
   * (TTL, dedup, storage) live in the shared `TtlSwrCache`.
   */
  private readonly cache: TtlSwrCache<UpdateStatus>;
  /**
   * Last completed check result (issue #221): while an apply is genuinely
   * running, `check()` serves this — with the live stage attached — instead
   * of probing git/gh against a source tree the shim is actively fetching,
   * resetting and rebuilding. `null` until the first check completes (a
   * daemon that boots mid-apply has nothing to serve yet and falls through
   * to a real check; the shim's git work is done by the restarting stage).
   */
  private lastBase: UpdateStatus | null = null;
  /**
   * SHA of the build this daemon process runs (issue #89): captured exactly
   * once, at construction (daemon boot) — the source checkout moves to the
   * new commit mid-update, so a check-time read would mistake the new HEAD
   * for the running build. Starts eagerly so even the first check() sees the
   * boot-time value; `null` when git fails (no repo at the checkout).
   * Also published to `<stateDir>/var/running-sha` (issue #198) so the
   * update shim can tell "source current but the daemon still runs an older
   * build" — the stale-restart trap hit live on the dev server.
   */
  private readonly runningSha: Promise<string | null>;

  constructor(options: UpdateCheckerOptions) {
    this.srcDir = options.srcDir;
    this.stateDir = options.stateDir;
    this.repoUrl = options.repoUrl;
    this.repoRef = options.repoRef;
    // Issue #221 diagnosis: the daemon's service PATH (`_serve_path` in
    // install/lib/service.sh) does not include the installer's private gh dir
    // — gh normally resolves through the ~/.local/bin symlink, which env
    // rewrites / shim refreshes can break. Fall back to the installer's own
    // copy at <stateDir>/opt/gh/bin/gh when the bare `gh` lookup fails with
    // ENOENT, and say so honestly when neither resolves.
    this.gh = options.gh ?? withPrivateGhFallback(defaultGhRunner, `${this.stateDir}/opt/gh/bin/gh`);
    this.git = options.git ?? defaultGitRunner;
    this.spawn = options.spawn ?? nodeSpawn;
    this.now = options.now ?? (() => new Date());
    this.cache = new TtlSwrCache<UpdateStatus>({
      ttlMs: options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      now: () => this.now().getTime(),
      swr: false,
    });
    this.runningSha = this.git(["rev-parse", "HEAD"], { cwd: this.srcDir })
      .then((result) => {
        const sha = result.stdout.trim() || null;
        if (sha !== null) this.writeRunningShaFile(sha);
        return sha;
      })
      .catch(() => null);
  }

  /** Publishes the boot SHA for the update shim (issue #198). Best effort. */
  private writeRunningShaFile(sha: string): void {
    try {
      mkdirSync(`${this.stateDir}/var`, { recursive: true });
      writeFileSync(`${this.stateDir}/var/running-sha`, `${sha}\n`);
    } catch {
      // unreadable state dir — the shim falls back to source-only comparison
    }
  }

  /**
   * Runs one check, served from cache while fresh (issue #76: the webapp
   * polls this; gh is consulted at most ~every 5 minutes — issue #82).
   * `force: true` (the webapp's `?refresh=1` on page load / window focus)
   * skips the cache read; the fresh result still becomes the new cache
   * entry. Never throws: failures surface in `error` with
   * `updateAvailable: false`, so the webapp/CLI always get a well-formed
   * status body.
   *
   * Every result also carries `runningSha` (the build this daemon process
   * runs, captured at boot — issue #89) and `applyProgress`, which is read
   * fresh from the update shim's state file even on cache hits so the
   * webapp's banner tracks the rebuild in real time while it polls.
   */
  async check(options: { force?: boolean } = {}): Promise<UpdateStatus> {
    // The shim's progress file is read fresh on every check so the webapp's
    // banner tracks the rebuild in real time while it polls.
    const progress = this.readProgress();
    // Issue #221: a live, non-terminal stage means an apply is genuinely
    // running — serve the last completed status (SHAs are still meaningful;
    // the webapp's apply polling keys on runningSha/progress) instead of
    // racing the shim's git fetch/reset and gh calls with our own probes.
    if (progress !== null && !isTerminalUpdateStage(progress.stage) && this.lastBase !== null) {
      return { ...this.lastBase, applyProgress: progress };
    }
    // `force` (the webapp's `?refresh=1` on page load / window focus) skips
    // the cache read; the fresh result still becomes the new cache entry.
    const base = await (options.force === true
      ? this.cache.refresh(CHECK_KEY, () => this.runCheck())
      : this.cache.get(CHECK_KEY, () => this.runCheck()));
    this.lastBase = base;
    // Read fresh again after the (possibly slow) gh round trip: an apply may
    // have started while the check ran.
    return { ...base, applyProgress: this.readProgress() };
  }

  /**
   * Reads the update shim's progress file (issue #89): the stage it wrote
   * last plus when. Returns `null` when missing, malformed, or stale — a
   * killed shim must never pin the webapp in a phantom "building" state.
   */
  private readProgress(): UpdateStatus["applyProgress"] {
    try {
      const parsed = JSON.parse(readFileSync(`${this.stateDir}/${PROGRESS_FILE}`, "utf8")) as {
        stage?: unknown;
        updatedAt?: unknown;
        error?: unknown;
      };
      if (typeof parsed.stage !== "string" || parsed.stage.length === 0) return null;
      if (typeof parsed.updatedAt !== "string" || !ISO_UTC_RE.test(parsed.updatedAt)) return null;
      const at = Date.parse(parsed.updatedAt);
      if (Number.isNaN(at) || this.now().getTime() - at > PROGRESS_TTL_MS) {
        // Stale (crashed/killed shim — issue #221): treat as dead AND clear
        // the debris so it can never resurface; the next apply starts clean.
        try {
          unlinkSync(`${this.stateDir}/${PROGRESS_FILE}`);
        } catch {
          // already gone / unreadable dir — nothing to clear
        }
        return null;
      }
      const error = typeof parsed.error === "string" && parsed.error.length > 0 ? parsed.error : undefined;
      return error === undefined
        ? { stage: parsed.stage, updatedAt: parsed.updatedAt }
        : { stage: parsed.stage, updatedAt: parsed.updatedAt, error };
    } catch {
      return null;
    }
  }

  /**
   * Applies a pending update (issue #76) by spawning the installed
   * `pideck update` shim detached — the daemon restarts mid-apply, so
   * callers return immediately after this resolves. The active-worker gate
   * is the caller's responsibility (handlers.ts), so a worker that became
   * active between check and apply is rejected before this runs.
   */
  async apply(): Promise<void> {
    const shim = `${this.stateDir}/bin/pideck`;
    if (!existsSync(shim)) {
      throw new HttpError(
        409,
        `no pideck shim at ${shim} — click-to-update needs an installed pideck (dev checkouts apply via the CLI)`,
      );
    }
    // Fresh progress cycle (issue #186): a prior apply's terminal stage
    // (done/failed) lingers in the progress file for its TTL — served fresh
    // on every check, the webapp's apply polling would read the OLD cycle's
    // outcome and resolve or report failure for THIS apply before the shim's
    // first write. Each apply starts clean. Best effort only.
    try {
      unlinkSync(`${this.stateDir}/${PROGRESS_FILE}`);
    } catch {
      // nothing to clear (no prior apply) — fine
    }
    // The shim's step/warn/die output must land somewhere inspectable (issue
    // #198: stdio:"ignore" made apply failures undebuggable — the dev server
    // had no trace of why its applies died). Append to the state dir's log.
    let stdio: SpawnOptions["stdio"] = "ignore";
    try {
      mkdirSync(`${this.stateDir}/log`, { recursive: true });
      const fd = openSync(`${this.stateDir}/log/update.log`, "a");
      appendFileSync(fd, `\n===== apply started ${this.now().toISOString()} =====\n`);
      stdio = ["ignore", fd, fd];
    } catch {
      // unwritable log dir — run silent rather than fail the apply
    }
    // Detached + unref'd: the shim outlives this process (the service
    // restart kills the daemon mid-apply, on purpose).
    this.spawn(shim, ["update"], { detached: true, stdio, cwd: this.stateDir }).unref();
    // Drop the parent's copy of the log fd (the child holds its own dup), so
    // repeated applies don't leak descriptors in the long-lived daemon.
    if (typeof stdio !== "string") closeSync(stdio[1] as number);
  }

  private async runCheck(): Promise<UpdateStatus> {
    const checkedAt = this.now().toISOString();
    const runningSha = await this.runningSha;
    let localSha: string | null = null;
    let remoteSha: string | null = null;
    const errors: string[] = [];

    // Local revision (independent of the remote check).
    try {
      localSha = (await this.git(["rev-parse", "HEAD"], { cwd: this.srcDir })).stdout.trim() || null;
    } catch (err) {
      errors.push(
        `no local source revision at ${this.srcDir}: ${errorMessage(err)} — run 'pideck update' to re-clone and rebuild (self-heals a corrupt checkout)`,
      );
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

    // Issue #198: `updateAvailable` is about the RUNNING build vs the remote
    // ref, not the source checkout — a crashed apply leaves the source
    // already reset to the target while the daemon still runs the old build
    // (the dev server read "up to date" with a stale build still serving).
    // Fall back to the source SHA when the boot SHA could not be captured.
    const effectiveSha = runningSha ?? localSha;
    const updateAvailable = effectiveSha !== null && remoteSha !== null && effectiveSha !== remoteSha;
    // Distinguishes "the source moved ahead of the running build" (restart
    // pending) from a plain upstream update.
    const runningBehindSource = runningSha !== null && localSha !== null && runningSha !== localSha;

    return {
      repo,
      ref,
      localSha,
      remoteSha,
      updateAvailable,
      checkedAt,
      error: errors.length > 0 ? errors.join("; ") : null,
      runningSha,
      runningBehindSource,
      applyProgress: null,
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

  /** Reads the installer's `~/.pideck/config.json` (best effort). */
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

/** An ENOENT spawn failure (gh missing) — GhError keeps the original as `cause`;
 * a raw execFile rejection carries the code top-level. */
function spawnEnoent(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "ENOENT" || e?.cause?.code === "ENOENT";
}

/**
 * Wraps a gh runner with a fallback to the installer's private gh binary
 * (issue #221): the daemon's service PATH can lose its gh entry (env
 * rewrites, a stale ~/.local/bin shim), but the installer's copy under
 * `<stateDir>/opt/gh/bin/gh` is exactly what `ensure_gh` (deps.sh) put
 * there — resolving it directly self-heals the daemon context instead of
 * failing every upstream check forever. When neither the bare `gh` nor the
 * private copy exists, the error says both were tried (the banner surfaces
 * the check error verbatim).
 */
export function withPrivateGhFallback(base: GhRunner, privateGh: string): GhRunner {
  return async (args, options) => {
    try {
      return await base(args, options);
    } catch (err) {
      if (!spawnEnoent(err)) throw err;
      try {
        const { stdout, stderr } = await execFileAsync(privateGh, args, {
          ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
          maxBuffer: 128 * 1024 * 1024,
          windowsHide: true,
        });
        return { stdout, stderr };
      } catch (fallbackErr) {
        const e = fallbackErr as { code?: number | string; stderr?: string };
        if (spawnEnoent(fallbackErr)) {
          throw new Error(
            `gh CLI not found on the daemon's PATH nor at ${privateGh} — reinstall pideck (or fix the daemon service PATH) and check 'gh auth login'`,
          );
        }
        throw new GhError(args, typeof e.code === "number" ? e.code : null, e.stderr ?? "", fallbackErr);
      }
    }
  };
}
