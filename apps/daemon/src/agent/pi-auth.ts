/**
 * pi auth probe (issue #57) — the daemon-side counterpart of the installer's
 * `install/onboard.sh` pi-auth detection.
 *
 * We never implement auth ourselves: like `onboard.sh`, we only *detect*
 * readiness by shelling out to pi's own `pi auth check --provider <p>
 * --no-refresh --json` for every known provider and collecting the ones that
 * report `"status":"ready"`. The configured startup model is read from pi's
 * own settings (`~/.pi/agent/settings.json`, the same file onboard.sh
 * records `PIDECK_MODEL` from).
 *
 * Used by:
 * - `GET /api/pi-auth` (webapp onboarding wizard + settings banner);
 * - the worker-spawn readiness gate (issue #56): an unauthenticated spawn
 *   must not have its initial prompt typed into an agent that cannot run;
 * - the `/api/status` pi fields + the daemon startup warning.
 *
 * Results are cached with stale-while-revalidate (default 5-minute TTL,
 * issue #100): no request-critical path ever waits on a probe once one has
 * run, and a full probe pass spawns all provider checks in parallel. Tests
 * inject a fake runner and can force fresh probes.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { piAuthSchema, type PiAuth } from "@pideck/shared";

import { TtlSwrCache } from "../api/swr-cache.js";

/**
 * Providers probed for ready credentials. Mirrors `PD_PI_PROVIDERS` in
 * `install/onboard.sh` — keep the two lists in sync.
 */
export const PI_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "google-vertex",
  "openai-codex",
  "openrouter",
  "github-copilot",
  "xai",
  "groq",
  "mistral",
  "amazon-bedrock",
  "zai",
  "nvidia",
] as const;

/** Runs the pi CLI (or a test fake) with the given argv. */
export type PiRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

/** Default runner: spawns the `pi` binary; a missing binary means "not ready". */
export const spawnPi: PiRunner = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new PiNotInstalledError("pi CLI not found on PATH"));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`pi ${args.join(" ")} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });

/** The pi CLI is not installed (distinct from "installed but unauthenticated"). */
export class PiNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiNotInstalledError";
  }
}

/**
 * Decides whether one provider's `pi auth check --json` output reports
 * ready: the stdout must parse as a JSON object carrying `"status":
 * "ready"` (any spacing — JSON parsing is spacing-agnostic), mirroring the
 * marker the installer matches. Unparseable or non-ready output is not
 * ready.
 */
export function providerAuthReady(stdout: string): boolean {
  const parsed = readyAuthSchema.safeParse(parseJson(stdout));
  return parsed.success;
}

const readyAuthSchema = z.object({ status: z.literal("ready") }).loose();

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Result of probing every provider: the ready ones (ordered like {@link PI_PROVIDERS}). */
export async function piReadyProviders(run: PiRunner): Promise<string[]> {
  // One spawn per provider, all in parallel (issue #100): a serial probe
  // costs providers × pi-startup on every cache miss — measured at ~139s
  // for the 13 providers on a user's Mac (~10s per pi invocation), which
  // stacked every /api/status poll into a daemon-freezing pileup.
  const verdicts = await Promise.all(
    PI_PROVIDERS.map(async (provider): Promise<string | null> => {
      try {
        const { stdout } = await run(["auth", "check", "--provider", provider, "--no-refresh", "--json"]);
        return providerAuthReady(stdout) ? provider : null;
      } catch (err) {
        if (err instanceof PiNotInstalledError) throw err; // no providers can be ready
        // A failing probe for one provider (e.g. non-zero exit when
        // unauthenticated) simply means that provider is not ready.
        return null;
      }
    }),
  );
  return verdicts.filter((provider): provider is string => provider !== null);
}

/** pi's saved startup defaults, read from its own settings.json. */
export interface PiStartupDefaults {
  defaultProvider: string | null;
  defaultModel: string | null;
}

/** Resolves the pi settings dir: `PD_PI_DIR`, else `~/.pi/agent` (matches install/lib/common.sh). */
export function piSettingsDir(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const fromEnv = process.env["PD_PI_DIR"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return path.join(os.homedir(), ".pi", "agent");
}

/** Reads `defaultProvider`/`defaultModel` from pi's settings.json (missing file/keys → null). */
export function readPiStartupDefaults(piDir?: string): PiStartupDefaults {
  try {
    const raw = JSON.parse(readFileSync(path.join(piSettingsDir(piDir), "settings.json"), "utf8")) as {
      defaultProvider?: unknown;
      defaultModel?: unknown;
    };
    return {
      defaultProvider: typeof raw.defaultProvider === "string" && raw.defaultProvider.length > 0 ? raw.defaultProvider : null,
      defaultModel: typeof raw.defaultModel === "string" && raw.defaultModel.length > 0 ? raw.defaultModel : null,
    };
  } catch {
    return { defaultProvider: null, defaultModel: null };
  }
}

/** Builds the probe's response body from ready providers + pi settings. */
export function piAuthPayloadFrom(providers: string[], installed: boolean, defaults: PiStartupDefaults): PiAuth {
  return piAuthSchema.parse({
    ready: providers.length > 0,
    providers,
    defaultProvider: defaults.defaultProvider,
    defaultModel: defaults.defaultModel,
    detail: !installed
      ? "pi is not installed on the daemon host — install it (npm i -g @earendil-works/pi-coding-agent) and re-check"
      : providers.length > 0
        ? `pi credentials ready for: ${providers.join(" ")}`
        : 'no ready pi provider — run "pideck onboard", or launch pi and use /login, on the daemon host',
  });
}

/**
 * First `x.y.z` (optionally with a prerelease/build suffix) in pi's
 * `--version` output; null when there is none (pi missing, garbage output).
 * `pi --version` may decorate the number, so a substring match wins over
 * trusting the whole line.
 */
function parsePiVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
  return match?.[1] ?? null;
}

export interface PiAuthProbeOptions {
  /** pi CLI runner. Default: spawn the real binary. */
  run?: PiRunner;
  /** pi settings dir override (tests). Default: `PD_PI_DIR` or `~/.pi/agent`. */
  piDir?: string;
  /** Probe-result TTL in ms. Default 300_000; `0` always probes fresh (deduplicated; tests). */
  ttlMs?: number;
  /** Injectable clock for the TTL (tests). */
  now?: () => number;
  /**
   * Test hook: force the readiness verdict without probing (also reports the
   * daemon-wide default used by `testDaemon`).
   */
  readyOverride?: boolean;
}

const DEFAULT_TTL_MS = 300_000;

/** Single-probe cache key ({@link PiAuthProbe} caches one daemon-wide verdict). */
const PROBE_KEY = "pi-auth";

/**
 * Cached pi-auth readiness probe (issue #100) — a thin policy over the
 * shared {@link TtlSwrCache} (#131): TTL, stale-while-revalidate,
 * single-flight, and failure-verdict caching are all the cache's mechanics.
 *
 * A full probe costs one pi spawn per provider (parallel, but still seconds
 * on slow hosts), so no request-critical path may wait on it once the probe
 * has run once:
 *
 * - cache fresh (age < TTL): the cached payload is served — 0 spawns;
 * - cache stale: the last-known payload is served **immediately** (with
 *   `stale: true`, via the cache's `onStale` marker) and at most 1
 *   background refresh runs (single-flight);
 * - cold (nothing cached yet, e.g. right after daemon start): the first
 *   caller awaits one probe pass, deduplicated across concurrent callers;
 * - a failed probe is cached for the TTL too (`cacheErrors`, the #100
 *   pileup guard): without caching, every request past the TTL re-triggers
 *   a full probe round on a host where pi is broken.
 *
 * {@link payload} backs `GET /api/status`, `GET /api/pi-auth`, and the
 * worker-spawn readiness gate; {@link readyProviders} is the raw list.
 */
export class PiAuthProbe {
  private readonly run: PiRunner;
  private readonly piDir?: string;
  private readonly readyOverride?: boolean;
  private readonly cache: TtlSwrCache<PiAuth>;
  /** Memoized `pi --version` result ({@link version}, issue #223). */
  private versionPromise?: Promise<string | null>;

  constructor(options: PiAuthProbeOptions = {}) {
    this.run = options.run ?? spawnPi;
    this.piDir = options.piDir;
    this.readyOverride = options.readyOverride;
    this.cache = new TtlSwrCache<PiAuth>({
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      now: options.now,
      cacheErrors: true,
      onStale: (payload) => ({ ...payload, stale: true }),
    });
  }

  /** Drops the cached result so the next {@link payload} probes afresh. */
  invalidate(): void {
    this.cache.invalidate();
  }

  /** Ready providers per the last probe (probing if the cache is stale). */
  async readyProviders(): Promise<string[]> {
    return (await this.payload()).providers;
  }

  /**
   * The installed pi version (issue #223), or null when pi is missing or its
   * `--version` output is unparseable. Memoized per probe instance (= per
   * daemon process): /api/status polls this on every request, and the
   * installed pi only changes through an update apply — which restarts the
   * daemon and freshens the memo with it. Like the auth probe, a failed run
   * reads as "unknown" (null), never as an error.
   */
  version(): Promise<string | null> {
    this.versionPromise ??= this.run(["--version"])
      .then((result) => parsePiVersion(result.stdout))
      .catch(() => null);
    return this.versionPromise;
  }

  /**
   * The shared `PiAuth` payload (stale-while-revalidate, see class docs).
   * `ttlMs: 0` keeps the old "always probe fresh" semantics (used by tests
   * that flip auth state mid-flight): the caller awaits a fresh, deduplicated
   * probe instead of receiving a stale value.
   */
  async payload(): Promise<PiAuth> {
    if (this.readyOverride !== undefined) {
      return piAuthPayloadFrom(this.readyOverride ? ["anthropic"] : [], true, readPiStartupDefaults(this.piDir));
    }
    try {
      return await this.cache.get(PROBE_KEY, () => this.probe());
    } catch (err) {
      // An unexpected probe failure must never read as "ready". The cache
      // holds the verdict for the TTL (`cacheErrors`), so later callers get
      // this same not-ready payload without re-probing (issue #100).
      const defaults = readPiStartupDefaults(this.piDir);
      return piAuthSchema.parse({
        ready: false,
        providers: [],
        defaultProvider: defaults.defaultProvider,
        defaultModel: defaults.defaultModel,
        detail: `pi auth probe failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** One probe pass: ready providers (or the not-installed verdict). */
  private async probe(): Promise<PiAuth> {
    const defaults = readPiStartupDefaults(this.piDir);
    try {
      const providers = await piReadyProviders(this.run);
      return piAuthPayloadFrom(providers, true, defaults);
    } catch (err) {
      if (err instanceof PiNotInstalledError) return piAuthPayloadFrom([], false, defaults);
      throw err; // cached by the TtlSwrCache (`cacheErrors`); converted in payload()
    }
  }
}
