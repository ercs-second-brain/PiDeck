/**
 * Context-usage probe: reports how full a session's context window is.
 *
 * How pi session state works (verified against pi 0.85.1 sources and on-disk
 * state):
 *
 * - Every interactive run appends one JSON line per event to a JSONL file in
 *   its session dir; `--session-dir <dir>` pins that dir, so every PiDeck
 *   session spawns with `--session-dir <stateDir>/pi-sessions/<sessionId>`
 *   and its JSONL is exactly where we chose — no reliance on pi's internal
 *   cwd-slug layout. A pi restart in the same dir starts a new file, so the
 *   newest `.jsonl` is the live one.
 * - The first line is `{"type":"session",...}`; model switches appear as
 *   `{"type":"model_change","provider":...,"modelId":...}`; assistant turns
 *   as `{"type":"message","message":{"role":"assistant","usage":{...}}}`.
 * - pi computes a turn's context tokens as
 *   `usage.totalTokens || input+output+cacheRead+cacheWrite` (its
 *   `calculateContextTokens`).
 * - The model's context window is NOT in the JSONL; it comes from pi's
 *   model catalog at `<agentDir>/models-store.json`, shaped
 *   `{ <provider>: { models: [{ id, contextWindow, ... }] } }`.
 * - `{"type":"compaction"}` entries reset the conversation; until the next
 *   assistant turn reports usage, the true occupancy is unknowable.
 *
 * This module therefore: reads the newest session JSONL under the pinned
 * session dir, walks it for the latest assistant usage and latest
 * model_change, looks up the context window in models-store.json, and
 * returns `tokens / window * 100` (one decimal). Anything missing,
 * unparseable, or behind a trailing compaction returns `null` — never a
 * guess.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session } from "@pideck/shared";

export interface ContextProbeOptions {
  /**
   * The daemon state dir: each session's pi JSONL lives under
   * `<stateDir>/pi-sessions/<sessionId>/` (pinned at spawn with
   * `--session-dir`).
   */
  stateDir: string;
  /** pi's agent dir (defaults to `$PI_CODING_AGENT_DIR` or `~/.pi/agent`). */
  agentDir?: string;
}

interface UsageInfo {
  tokens: number;
  model: { provider: string; modelId: string } | null;
  trailingCompaction: boolean;
}

function resolveAgentDir(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env !== undefined && env.length > 0) return env;
  return join(homedir(), ".pi", "agent");
}

function newestSessionFile(dir: string): string | null {
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let newest: string | null = null;
  let newestMtime = -1;
  for (const name of files) {
    const full = join(dir, name);
    const mtime = statSync(full).mtimeMs;
    if (mtime > newestMtime) {
      newest = full;
      newestMtime = mtime;
    }
  }
  return newest;
}

function contextTokens(usage: Record<string, unknown>): number {
  const total = usage["totalTokens"];
  if (typeof total === "number" && total > 0) return total;
  const sum = (key: string): number => {
    const value = usage[key];
    return typeof value === "number" ? value : 0;
  };
  return sum("input") + sum("output") + sum("cacheRead") + sum("cacheWrite");
}

/** Extracts the latest assistant usage and model from one JSONL file. */
function scanSessionFile(file: string): UsageInfo | null {
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    return null;
  }
  let tokens: number | null = null;
  let model: { provider: string; modelId: string } | null = null;
  let compactionAfterUsage = false;
  for (const line of lines) {
    if (line.trim() === "") continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry["type"] === "compaction" && tokens !== null) {
      compactionAfterUsage = true;
    }
    if (entry["type"] === "model_change") {
      const provider = entry["provider"];
      const modelId = entry["modelId"];
      if (typeof provider === "string" && typeof modelId === "string") {
        model = { provider, modelId };
      }
    }
    if (entry["type"] === "message") {
      const message = entry["message"] as Record<string, unknown> | undefined;
      if (message?.["role"] !== "assistant") continue;
      if (message["stopReason"] === "aborted" || message["stopReason"] === "error") continue;
      const usage = message["usage"] as Record<string, unknown> | undefined;
      if (usage === undefined) continue;
      const used = contextTokens(usage);
      if (used > 0) {
        tokens = used;
        compactionAfterUsage = false;
      }
    }
  }
  return tokens === null ? null : { tokens, model, trailingCompaction: compactionAfterUsage };
}

function lookupContextWindow(agentDir: string, model: { provider: string; modelId: string }): number | null {
  let catalog: unknown;
  try {
    catalog = JSON.parse(readFileSync(join(agentDir, "models-store.json"), "utf8"));
  } catch {
    return null;
  }
  const provider = (catalog as Record<string, unknown>)[model.provider] as
    | Record<string, unknown>
    | undefined;
  const models = provider?.["models"];
  if (!Array.isArray(models)) return null;
  for (const entry of models) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      (entry as Record<string, unknown>)["id"] === model.modelId
    ) {
      const window = (entry as Record<string, unknown>)["contextWindow"];
      return typeof window === "number" && window > 0 ? window : null;
    }
  }
  return null;
}

/**
 * Context-window usage of a session's latest pi turn, in percent (one
 * decimal). Returns `null` when it cannot be known: no session file in the
 * pinned session dir, no assistant usage yet, an unknown model or context
 * window, or a compaction after the last measured turn.
 */
export function contextPercent(session: Session, options: ContextProbeOptions): number | null {
  const agentDir = resolveAgentDir(options.agentDir);
  const file = newestSessionFile(join(options.stateDir, "pi-sessions", session.id));
  if (file === null) return null;
  const info = scanSessionFile(file);
  if (info === null || info.trailingCompaction) return null;
  if (info.model === null) return null;
  const window = lookupContextWindow(agentDir, info.model);
  if (window === null) return null;
  return Math.round((info.tokens / window) * 1000) / 10;
}
