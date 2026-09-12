import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PiProbeSchema, ProbeSchema, type PiProbe, type Probe } from "@pideck/shared";
import { GhClient } from "../github/client.js";

/**
 * Onboarding probes. pi's model catalogue lives at `~/.pi/agent/models-store.json`
 * (providers → models) and pi's defaults at `~/.pi/agent/settings.json`; the gh
 * probes shell out to `gh auth status`, once with the primary identity and once
 * with the review account's token from global settings.
 */
export function piProbe(): PiProbe {
  const settingsFile = join(homedir(), ".pi", "agent", "settings.json");
  if (!existsSync(settingsFile)) {
    return PiProbeSchema.parse({
      ok: false,
      detail: `pi settings not found at ${settingsFile}`,
      providers: [],
      models: [],
      defaultModel: null,
    });
  }
  const settings = readJson(settingsFile) as { defaultModel?: string | null };
  const modelsFile = join(homedir(), ".pi", "agent", "models-store.json");
  const store = existsSync(modelsFile)
    ? (readJson(modelsFile) as Record<string, { models?: { id?: string }[] }>)
    : {};
  const providers = Object.keys(store).sort();
  const models = [
    ...new Set(
      providers
        .flatMap((provider) => store[provider]?.models ?? [])
        .map((model) => model.id)
        .filter((id): id is string => id !== undefined),
    ),
  ].sort();
  return PiProbeSchema.parse({
    ok: true,
    detail: `pi configured: ${providers.length} providers, ${models.length} models`,
    providers,
    models,
    defaultModel: settings.defaultModel ?? null,
  });
}

/** Probes `gh auth status` with the primary (login) identity. */
export function ghPrimaryProbe(): Promise<Probe> {
  return new GhClient({ repo: PROBE_REPO }).authStatus();
}

/** Probes `gh auth status` using the review account's token, when set. */
export function ghReviewProbe(reviewToken: string | null): Promise<Probe> {
  if (reviewToken === null) {
    return Promise.resolve(ProbeSchema.parse({ ok: false, detail: "review account not configured" }));
  }
  return new GhClient({ repo: PROBE_REPO, token: reviewToken }).authStatus();
}

/** The repo field is unused by `gh auth status`; any placeholder works. */
const PROBE_REPO = "-";

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path}: not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}