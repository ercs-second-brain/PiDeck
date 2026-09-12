/**
 * The debugging record: an append-only JSONL per session at
 * `<stateDir>/traces/<sessionId>.jsonl` — the deliveries the daemon sent,
 * the state transitions it derived, and the compact GitHub facts behind
 * each tick. Deliveries, spawns, and archives are written from the apply
 * path after the action executed; state and facts entries are written from
 * state derivation, only when something actually changed. Each line is
 * clamped to 1 KB, so a tick can never write more than that. The file sits
 * next to the captured pane log and outlives archive — nothing here or in
 * the archive path ever removes it.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { TraceEntrySchema, type Session, type TraceEntry, type TraceFacts, type WorkerState } from "@pideck/shared";
import { statePaths } from "../store/stateDir.js";
import type { ProjectFacts } from "./read.js";

const MAX_LINE_BYTES = 1024;

export function traceFile(stateDir: string, sessionId: string): string {
  return join(statePaths(stateDir).tracesDir, `${sessionId}.jsonl`);
}

/** The session's pinned pi transcript (newest JSONL), or null when gone. */
export function piTranscriptPath(stateDir: string, sessionId: string): string | null {
  const dir = join(statePaths(stateDir).piSessionsDir, sessionId);
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

/**
 * The compact facts snapshot for one session: its issue (blockers) and its
 * PR (head, CI, review decision, mergeability) from the last read pass.
 * Null when nothing about this session is on GitHub right now.
 */
export function compactFacts(session: Session, facts: ProjectFacts | null): TraceFacts | null {
  if (facts === null) return null;
  const result: TraceFacts = {};
  const issue =
    session.issueNumber === undefined ? null : (facts.issues.find((i) => i.number === session.issueNumber) ?? null);
  if (issue !== null) {
    result.issueNumber = issue.number;
    result.openBlockers = issue.openBlockers;
  }
  const pr =
    (session.prNumber === undefined
      ? undefined
      : facts.prs.find((p) => p.number === session.prNumber)) ??
    (session.issueNumber === undefined
      ? undefined
      : facts.prs.find((p) => p.issueNumber === session.issueNumber)) ??
    null;
  if (pr !== null) {
    result.prNumber = pr.number;
    result.headSha = pr.headSha;
    result.ci = pr.ciStatus;
    if (pr.failingChecks.length > 0) result.failingChecks = pr.failingChecks;
    result.reviewDecision = pr.reviewDecision;
    result.mergeable = pr.mergeable;
  }
  return Object.keys(result).length === 0 ? null : result;
}

/**
 * Writes and reads session traces. Deduplication of state and facts entries
 * is in-memory: a restart re-records the current state and facts once, the
 * same way a restart can cost one duplicate prompt.
 */
export class Trace {
  readonly #stateDir: string;
  #lastState = new Map<string, { state: WorkerState | null; status: string }>();
  #lastFacts = new Map<string, string>();

  constructor(stateDir: string) {
    this.#stateDir = stateDir;
  }

  /** Appends one entry as a single clamped JSONL line. */
  append(sessionId: string, entry: TraceEntry): void {
    const file = traceFile(this.#stateDir, sessionId);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${clampEntry(entry)}\n`, "utf8");
  }

  /**
   * State-derivation hook: writes a `state` entry when the derived state or
   * status changed, and a `facts` entry when the GitHub facts behind the
   * session changed. Called on every derived view; both are deduped here.
   */
  recordDerived(
    sessionId: string,
    state: WorkerState | null,
    status: string,
    facts: TraceFacts | null,
  ): void {
    const previous = this.#lastState.get(sessionId);
    if (previous === undefined || previous.state !== state || previous.status !== status) {
      this.#lastState.set(sessionId, { state, status });
      this.append(sessionId, {
        at: new Date().toISOString(),
        kind: "state",
        from: previous?.state ?? null,
        to: state,
        status,
      });
    }
    if (facts !== null) {
      const key = JSON.stringify(facts);
      if (this.#lastFacts.get(sessionId) !== key) {
        this.#lastFacts.set(sessionId, key);
        this.append(sessionId, { at: new Date().toISOString(), kind: "facts", facts });
      }
    }
  }

  /** Every recorded entry, in the order they were appended. */
  read(sessionId: string): TraceEntry[] {
    let lines: string[];
    try {
      lines = readFileSync(traceFile(this.#stateDir, sessionId), "utf8").split("\n");
    } catch {
      return [];
    }
    const entries: TraceEntry[] = [];
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        entries.push(TraceEntrySchema.parse(JSON.parse(line)));
      } catch {
        // A torn or foreign line is skipped, never fatal.
      }
    }
    return entries;
  }

  /** The pi transcript for this session, when it still exists. */
  transcriptPath(sessionId: string): string | null {
    return existsSync(join(statePaths(this.#stateDir).piSessionsDir, sessionId))
      ? piTranscriptPath(this.#stateDir, sessionId)
      : null;
  }
}

/** Keeps a single JSONL line within the per-tick budget: drop the bulky
 *  optional payloads first, then truncate the free-text field. */
function clampEntry(entry: TraceEntry): string {
  if (JSON.stringify(entry).length <= MAX_LINE_BYTES) return JSON.stringify(entry);
  const slim: TraceEntry = { ...entry, watermark: undefined, facts: undefined };
  if (JSON.stringify(slim).length <= MAX_LINE_BYTES) return JSON.stringify(slim);
  const field: "text" | "detail" | "status" =
    slim.text !== undefined ? "text" : slim.detail !== undefined ? "detail" : "status";
  const value = slim[field];
  if (value === undefined) return JSON.stringify(slim);
  const without: TraceEntry =
    field === "text" ? { ...slim, text: "" } : field === "detail" ? { ...slim, detail: "" } : { ...slim, status: "" };
  const budget = Math.max(0, MAX_LINE_BYTES - JSON.stringify(without).length - 1);
  const cut = `${value.slice(0, budget)}…`;
  const result: TraceEntry =
    field === "text" ? { ...slim, text: cut } : field === "detail" ? { ...slim, detail: cut } : { ...slim, status: cut };
  return JSON.stringify(result);
}
