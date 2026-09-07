/**
 * pi auth probe (issue #57) — the daemon-side counterpart of the installer's
 * `install/onboard.sh` pi-auth detection.
 *
 * We never implement auth ourselves: like `onboard.sh`, we only *detect*
 * readiness by shelling out to pi's own `pi auth check --provider <p>
 * --no-refresh --json` for every known provider and collecting the ones that
 * report `"status":"ready"`. The configured startup model is read from pi's
 * own settings (`~/.pi/agent/settings.json`, the same file onboard.sh
 * records `AGENTSKISS_MODEL` from).
 *
 * Used by:
 * - `GET /api/pi-auth` (webapp onboarding wizard + settings banner);
 * - the worker-spawn readiness gate (issue #56): an unauthenticated spawn
 *   must not have its initial prompt typed into an agent that cannot run;
 * - the `/api/status` pi fields + the daemon startup warning.
 *
 * Results are cached briefly (default 30s) so polling endpoints do not burn
 * a process spawn per provider on every request; tests inject a fake runner
 * and can force fresh probes.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { piAuthSchema, type PiAuth } from "@agentskiss/shared";

/**
 * Providers probed for ready credentials. Mirrors `AK_PI_PROVIDERS` in
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
 * ready. Tolerates the two JSON spacings the installer matches (`"status":
 * "ready"` and `"status":"ready"`) so a provider whose JSON we cannot parse
 * still counts when it carries the ready marker.
 */
export function providerAuthReady(stdout: string): boolean {
  const compact = stdout.replaceAll(" ", "");
  return compact.includes('"status":"ready"');
}

/** Result of probing every provider: the ready ones (ordered like {@link PI_PROVIDERS}). */
export async function piReadyProviders(run: PiRunner): Promise<string[]> {
  const ready: string[] = [];
  for (const provider of PI_PROVIDERS) {
    try {
      const { stdout } = await run(["auth", "check", "--provider", provider, "--no-refresh", "--json"]);
      if (providerAuthReady(stdout)) ready.push(provider);
    } catch (err) {
      if (err instanceof PiNotInstalledError) throw err; // no providers can be ready
      // A failing probe for one provider (e.g. non-zero exit when
      // unauthenticated) simply means that provider is not ready.
    }
  }
  return ready;
}

/** pi's saved startup defaults, read from its own settings.json. */
export interface PiStartupDefaults {
  defaultProvider: string | null;
  defaultModel: string | null;
}

/** Resolves the pi settings dir: `AGENTSKISS_PI_DIR`, else `~/.pi/agent` (matches install/lib/common.sh). */
export function piSettingsDir(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const fromEnv = process.env["AGENTSKISS_PI_DIR"];
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
        : 'no ready pi provider — run "agentskiss onboard", or launch pi and use /login, on the daemon host',
  });
}

export interface PiAuthProbeOptions {
  /** pi CLI runner. Default: spawn the real binary. */
  run?: PiRunner;
  /** pi settings dir override (tests). Default: `AGENTSKISS_PI_DIR` or `~/.pi/agent`. */
  piDir?: string;
  /** Probe-result TTL in ms. Default 30_000; `0` disables caching (tests). */
  ttlMs?: number;
  /** Injectable clock for the TTL (tests). */
  now?: () => number;
  /**
   * Test hook: force the readiness verdict without probing (also reports the
   * daemon-wide default used by `testDaemon`).
   */
  readyOverride?: boolean;
}

/**
 * Cached pi-auth readiness probe. {@link payload} returns the shared
 * `PiAuth` contract body; {@link readyProviders} the raw provider list.
 */
export class PiAuthProbe {
  private readonly run: PiRunner;
  private readonly piDir?: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly readyOverride?: boolean;
  private cached: PiAuth | null = null;
  private cachedAt = 0;
  private inFlight: Promise<PiAuth> | null = null;

  constructor(options: PiAuthProbeOptions = {}) {
    this.run = options.run ?? spawnPi;
    this.piDir = options.piDir;
    this.ttlMs = options.ttlMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.readyOverride = options.readyOverride;
  }

  /** Drops the cached result so the next {@link payload} probes afresh. */
  invalidate(): void {
    this.cached = null;
    this.cachedAt = 0;
  }

  /** Ready providers per the last probe (probing if the cache is stale). */
  async readyProviders(): Promise<string[]> {
    return (await this.payload()).providers;
  }

  /** The shared `PiAuth` payload (cached for {@link PiAuthProbeOptions.ttlMs}). */
  async payload(): Promise<PiAuth> {
    if (this.readyOverride !== undefined) {
      return piAuthPayloadFrom(this.readyOverride ? ["anthropic"] : [], true, readPiStartupDefaults(this.piDir));
    }
    const now = this.now();
    if (this.cached !== null && this.ttlMs > 0 && now - this.cachedAt < this.ttlMs) return this.cached;
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.probe().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async probe(): Promise<PiAuth> {
    const defaults = readPiStartupDefaults(this.piDir);
    try {
      const providers = await piReadyProviders(this.run);
      const payload = piAuthPayloadFrom(providers, true, defaults);
      this.cache(payload);
      return payload;
    } catch (err) {
      if (err instanceof PiNotInstalledError) {
        const payload = piAuthPayloadFrom([], false, defaults);
        this.cache(payload);
        return payload;
      }
      // An unexpected probe failure must never read as "ready": report
      // not-ready without poisoning the cache for longer than the TTL.
      return piAuthSchema.parse({
        ready: false,
        providers: [],
        defaultProvider: defaults.defaultProvider,
        defaultModel: defaults.defaultModel,
        detail: `pi auth probe failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private cache(payload: PiAuth): void {
    this.cached = payload;
    this.cachedAt = this.now();
  }
}
