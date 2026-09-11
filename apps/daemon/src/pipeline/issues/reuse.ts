/**
 * Idle-worker reuse (issue #471): the context-window probe and the
 * `ReusePolicy` port the deterministic spawn pipeline consults BEFORE
 * scheduling a fresh spawn.
 *
 * The idea: when a worker finishes its task (`done`) and goes idle, a
 * follow-on task in the same conceptual lane can be handed to that worker
 * instead of spawning fresh — the project knowledge and conventions are
 * already loaded, so the follow-on starts warmer and related changes stay
 * well-aligned. BUT only within a context budget: a worker that has
 * consumed more than the configured percent of its context window is not
 * reused (a fresh worker spawns instead).
 *
 * Context accounting (the probe): pi persists every turn to
 * `<agentDir>/sessions/<cwd-slug>/<timestamp>_<sessionid>.jsonl`; each
 * assistant message carries the provider usage (`input`, `cacheRead`,
 * `cacheWrite`). Context occupancy = input + cacheRead + cacheWrite at the
 * latest assistant message; the context window comes from pi's
 * models-store.json (via the latest `model_change`'s provider + model id).
 * The cwd slug is pi's own encoding of the worker's recorded working
 * directory (`--<cwd with separators/colons mapped to dashes>--`).
 *
 * Conservative by design: a missing/unparseable session file, no assistant
 * usage, or an unknown model/context window ⇒ usage UNKNOWN ⇒ the worker
 * is NOT reusable. An honest caveat: an in-flight turn can push the
 * context past the threshold after a check — the next follow-on decision
 * re-probes the fresher file.
 *
 * The lane key is spawn-request metadata (`pideck spawn --lane <slug>`,
 * recorded on the worker record): NO lane on the new task ⇒ NO reuse — a
 * lane-less spawn takes the deterministic fresh-spawn default. Issue
 * labels were rejected deliberately as the key.
 *
 * Eligibility (all must hold): worker status `done`, its tmux pane still
 * alive, lane match, same project (the lookup is per project), context
 * occupancy at/below the threshold, and not stall-marked (the #478 sweep
 * writes `stalled …` status messages) or `failed`. `done` is a terminal
 * status, so the stall sweep never races reuse (it only acts on
 * non-terminal workers); re-tasking resets the stall streak and #480's
 * multi-PR `prNumbers` accumulate untouched. Reuse is slot-neutral — the
 * worker already occupies its concurrency slot.
 */

import { readFile as readFileFs, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { Session, Worker } from "@pideck/shared";

import type { SessionManager } from "../../sessions/manager.js";

// ---------------------------------------------------------------------------
// Context-window probe
// ---------------------------------------------------------------------------

/** Context usage resolved from the worker's pi session telemetry. */
export type ContextUsage =
  | { kind: "known"; used: number; contextWindow: number; pct: number }
  | { kind: "unknown"; reason: string };

/** The probe's injectable filesystem (tests); defaults to the real fs. */
export interface ContextUsageProbeDeps {
  /**
   * pi agent dir. Default: `$PI_CODING_AGENT_DIR` when set (the env pi
   * itself honors), else `~/.pi/agent`.
   */
  agentDir?: string;
  /** Directory listing. Default: `fs/promises.readdir`. */
  readDir?: (dir: string) => Promise<string[]>;
  /** File read. Default: `fs/promises.readFile` (utf8). */
  readFile?: (file: string) => Promise<string>;
}

/**
 * pi's cwd → session-dir encoding (dist/core/session-manager.js
 * `getDefaultSessionDirPath`): `--<cwd without a leading separator, all
 * separators/colons mapped to dashes>--` under `<agentDir>/sessions/`.
 */
export function piSessionDir(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(agentDir, "sessions", safePath);
}

/** The default pi agent dir (mirrors pi's own resolution). */
export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const envDir = env["PI_CODING_AGENT_DIR"];
  if (envDir !== undefined && envDir.length > 0) return envDir;
  return path.join(homedir(), ".pi", "agent");
}

/** One pi session event line we care about (subset of the real shape). */
interface SessionEvent {
  type?: unknown;
  /** `model_change` events. */
  provider?: unknown;
  modelId?: unknown;
  /** `message` events. */
  message?: {
    role?: unknown;
    model?: unknown;
    usage?: { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The latest assistant usage line, if it carries a complete numeric usage. */
function assistantUsage(event: SessionEvent): { input: number; cacheRead: number; cacheWrite: number } | null {
  if (event.type !== "message") return null;
  const message = event.message;
  if (!isRecord(message) || message.role !== "assistant") return null;
  const u = message.usage;
  if (
    !isRecord(u) ||
    typeof u["input"] !== "number" ||
    typeof u["cacheRead"] !== "number" ||
    typeof u["cacheWrite"] !== "number"
  ) {
    return null;
  }
  return { input: u["input"], cacheRead: u["cacheRead"], cacheWrite: u["cacheWrite"] };
}

/** The latest model_change's provider + model id, if well-formed. */
function modelChange(event: SessionEvent): { provider: string; modelId: string } | null {
  if (event.type !== "model_change") return null;
  if (typeof event.provider !== "string" || typeof event.modelId !== "string") return null;
  return { provider: event.provider, modelId: event.modelId };
}

/**
 * Scans one session JSONL for the latest assistant usage and the latest
 * model change. Unparseable lines are skipped (pi appends defensively).
 * Returns `null` when the file carries no assistant usage.
 */
function scanSession(
  content: string,
): { usage: { input: number; cacheRead: number; cacheWrite: number }; model: { provider: string; modelId: string } | null } | null {
  let usage: { input: number; cacheRead: number; cacheWrite: number } | null = null;
  let model: { provider: string; modelId: string } | null = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: SessionEvent;
    try {
      event = JSON.parse(trimmed) as SessionEvent;
    } catch {
      continue; // corrupt line: skip, keep scanning
    }
    if (!isRecord(event)) continue;
    const changed = modelChange(event);
    if (changed !== null) model = changed;
    const used = assistantUsage(event);
    if (used !== null) usage = used;
  }
  if (usage === null) return null;
  return { usage, model };
}

/**
 * Reads the contextWindow for a provider+model id from pi's
 * models-store.json (`<agentDir>/models-store.json`, the model catalog pi
 * resolves from). Returns `null` when the store, provider, or model id is
 * unknown — the caller treats that as UNKNOWN usage (not reusable).
 */
async function readContextWindow(
  agentDir: string,
  provider: string,
  modelId: string,
  readFile: (file: string) => Promise<string>,
): Promise<number | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(agentDir, "models-store.json")));
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const providers = raw["providers"];
  if (!isRecord(providers) || !isRecord(providers[provider])) return null;
  const models = providers[provider]["models"];
  if (!Array.isArray(models)) return null;
  for (const model of models) {
    if (isRecord(model) && model["id"] === modelId && typeof model["contextWindow"] === "number") {
      return model["contextWindow"];
    }
  }
  return null;
}

/**
 * Probes one worker's context occupancy: locates the pi session dir from
 * the worker's recorded cwd, reads the newest session file's latest
 * assistant usage, and divides by the context window of the latest
 * model_change's model (from models-store.json).
 *
 * Anything missing or unparseable ⇒ `{ kind: "unknown" }` — the caller
 * must treat an unknown-usage worker as NOT reusable (conservative).
 */
export async function readWorkerContextUsage(cwd: string, deps: ContextUsageProbeDeps = {}): Promise<ContextUsage> {
  const readDir = deps.readDir ?? readdir;
  const readFile = deps.readFile ?? ((file: string) => readFileFs(file, "utf8"));
  const agentDir = deps.agentDir ?? defaultAgentDir();
  let files: string[];
  try {
    files = (await readDir(piSessionDir(cwd, agentDir))).filter((name) => name.endsWith(".jsonl"));
  } catch (err) {
    return { kind: "unknown", reason: `session dir unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Newest session first: pi prefixes filenames with the session start
  // timestamp (ISO, dash-separated — sorts lexically). The worker's cwd is
  // per-worker (fresh worktree), so the newest file is its session.
  for (const name of files.sort().reverse()) {
    let content: string;
    try {
      content = await readFile(path.join(piSessionDir(cwd, agentDir), name));
    } catch {
      continue; // unreadable file: try the next one
    }
    const scanned = scanSession(content);
    if (scanned === null) continue; // no assistant usage in this file
    const used = scanned.usage.input + scanned.usage.cacheRead + scanned.usage.cacheWrite;
    if (scanned.model === null) {
      return { kind: "unknown", reason: "no model_change in the session file" };
    }
    const contextWindow = await readContextWindow(agentDir, scanned.model.provider, scanned.model.modelId, readFile);
    if (contextWindow === null || contextWindow <= 0) {
      return { kind: "unknown", reason: `unknown context window for ${scanned.model.provider}/${scanned.model.modelId}` };
    }
    return {
      kind: "known",
      used,
      contextWindow,
      pct: (used / contextWindow) * 100,
    };
  }
  return { kind: "unknown", reason: "no assistant usage in any session file" };
}

// ---------------------------------------------------------------------------
// Reuse policy
// ---------------------------------------------------------------------------

/** One reuse decision's inputs — all resolved fresh by the caller. */
export interface ReuseRequest {
  projectId: string;
  /** The new task's conceptual lane (spawn-request metadata, #471). */
  lane: string;
  /**
   * Context threshold in percent of the context window (the
   * `workerReuseContextThreshold` setting, resolved per project — read
   * fresh on every decision). A candidate at/below it is reusable.
   */
  thresholdPct: number;
}

/**
 * The reuse port (issue #471): the deterministic spawn pipeline consults
 * it BEFORE scheduling a fresh spawn. No implementation in the pipeline —
 * the port keeps the probe (fs, pi telemetry) out of the pipeline and the
 * tests hermetic.
 */
export interface ReusePolicy {
  /** The eligible reusable worker for the lane, or `null` (spawn fresh). */
  findReusableWorker(request: ReuseRequest): Promise<Worker | null>;
}

/** What the default policy needs from the session facade. */
export interface DefaultReusePolicyDeps {
  /** Workers of one project (`SessionManager.listWorkers`). */
  listWorkers: (projectId: string) => Worker[];
  /** The registry session for a worker (carries the recorded cwd). */
  getSession: (sessionId: string) => Session | undefined;
  /** Whether the worker's tmux pane is still alive (`SessionManager.isAlive`). */
  isAlive: (sessionId: string) => Promise<boolean>;
  /** Probe injection points (tests). */
  probe?: ContextUsageProbeDeps;
}

/** Default {@link ReusePolicy}: registry-backed, probed against pi's session telemetry. */
export class DefaultReusePolicy implements ReusePolicy {
  private readonly deps: DefaultReusePolicyDeps;

  constructor(deps: DefaultReusePolicyDeps) {
    this.deps = deps;
  }

  async findReusableWorker(request: ReuseRequest): Promise<Worker | null> {
    // Same project only (the lookup is per project by construction).
    const candidates = this.deps.listWorkers(request.projectId).filter(
      (worker) =>
        worker.lane === request.lane && // lane match (#471 key)
        worker.status === "done" && // idle: done is terminal, so #478 never races reuse
        !isStallMarked(worker), // a stall-marked worker is not idle capacity (#478)
    );
    for (const worker of candidates) {
      const session = this.deps.getSession(worker.sessionId);
      if (session === undefined) continue;
      if (session.archivedAt !== undefined) continue; // archived panes never
      if (!(await this.deps.isAlive(session.id))) continue; // pane alive
      if (session.cwd === undefined) continue; // no recorded cwd → cannot probe
      const usage = await readWorkerContextUsage(session.cwd, this.deps.probe);
      if (usage.kind !== "known") continue; // conservative: unknown ⇒ not reusable
      if (usage.pct > request.thresholdPct) continue; // over budget ⇒ fresh spawn
      return worker;
    }
    return null;
  }
}

/** A stall-marked worker (the #478 sweep's `stalled …` status messages). */
function isStallMarked(worker: Worker): boolean {
  return worker.statusMessage !== null && worker.statusMessage.toLowerCase().includes("stalled");
}

/**
 * Convenience adapter: builds a {@link DefaultReusePolicy} over the real
 * `SessionManager` (the daemon wiring uses this; tests inject fakes).
 */
export function sessionReusePolicy(sessions: SessionManager, probe?: ContextUsageProbeDeps): ReusePolicy {
  return new DefaultReusePolicy({
    listWorkers: (projectId) => sessions.listWorkers({ projectId }),
    getSession: (sessionId) => sessions.getSession(sessionId),
    isAlive: (sessionId) => sessions.isAlive(sessionId),
    ...(probe !== undefined ? { probe } : {}),
  });
}
