/**
 * Archived scrollback persistence (issue #104): the tmux pane scrollback
 * captured at terminate time, keyed by record id, persisted as a single
 * JSON file under the daemon state dir via {@link JsonStore} (issue #72's
 * unified persistence). Writes only happen at termination, so one file
 * (instead of per-record files) stays trivially small.
 *
 * Keys are worker ids (worker terminations, issue #64) and — since issue
 * #357 B9 — persona-agent session ids (`Session.archivedAt` terminates):
 * the id spaces are disjoint (`worker-…` vs `sess-…`), so one store serves
 * both archives.
 *
 * Kept separate from the session registry: scrollback blobs are the largest
 * payloads the daemon persists, and the registry is rewritten on every
 * session/status change — mixing the two would make every registry save
 * carry kilobytes of dead pane text.
 */

import { JsonStore } from "../json-store.js";

/** How much scrollback to capture at termination (issue #104): the tmux
 * server's default history limit, so a full pane history fits. Shared by
 * the worker (#64) and persona-agent (#357 B9) archive paths. */
export const ARCHIVED_SCROLLBACK_LINES = 2000;

/** One archived pane's captured bytes (worker or persona-agent termination). */
export interface ArchivedScrollback {
  /** ISO timestamp of the capture (termination time). */
  capturedAt: string;
  /** Captured pane text, trailing newlines trimmed. */
  scrollback: string;
}

interface PersistedLogs {
  version: 1;
  logs: Record<string, ArchivedScrollback>;
}

const STATE_VERSION = 1;

/** Validates a parsed file, dropping malformed entries instead of rejecting the file. */
function validatePersistedLogs(value: unknown): PersistedLogs | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Partial<PersistedLogs>;
  const logs: Record<string, ArchivedScrollback> = {};
  for (const [workerId, entry] of Object.entries(raw.logs ?? {})) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Partial<ArchivedScrollback>;
    if (typeof candidate.capturedAt === "string" && typeof candidate.scrollback === "string") {
      logs[workerId] = { capturedAt: candidate.capturedAt, scrollback: candidate.scrollback };
    }
  }
  return { version: STATE_VERSION, logs };
}

/** Fresh literal per construction — NEVER a shared module constant: the
 * fallback is returned by reference and `this.logs` aliases it, so a shared
 * empty would leak logs across store instances in-process (issue #372 —
 * the AgentKindStore trap, found by its tests during #368). */
const empty = (): PersistedLogs => ({ version: STATE_VERSION, logs: {} });

export class ArchivedLogStore {
  private readonly store: JsonStore<PersistedLogs>;
  private logs: Record<string, ArchivedScrollback>;

  constructor(filePath: string) {
    this.store = new JsonStore(filePath);
    this.logs = this.store.load(validatePersistedLogs, empty()).logs;
  }

  /** Persists (or overwrites) a worker's captured scrollback. */
  save(workerId: string, entry: ArchivedScrollback): void {
    this.logs[workerId] = entry;
    this.store.save({ version: STATE_VERSION, logs: this.logs });
  }

  /** The worker's captured scrollback, if one was captured. */
  get(workerId: string): ArchivedScrollback | undefined {
    return this.logs[workerId];
  }

  /** Deletes the captured scrollback of the given workers (issue #172 project
   * teardown: deleting a project deletes its archived logs too). Idempotent. */
  deleteWorkers(workerIds: Iterable<string>): void {
    let changed = false;
    for (const workerId of workerIds) {
      if (workerId in this.logs) {
        delete this.logs[workerId];
        changed = true;
      }
    }
    if (changed) this.store.save({ version: STATE_VERSION, logs: this.logs });
  }
}
