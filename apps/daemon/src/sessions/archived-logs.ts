/**
 * Archived-worker scrollback persistence (issue #104): the tmux pane
 * scrollback captured at terminate time, keyed by worker id, persisted as a
 * single JSON file under the daemon state dir via {@link JsonStore} (issue
 * #72's unified persistence). Writes only happen when a worker is archived,
 * so one file (instead of per-worker files) stays trivially small.
 *
 * Kept separate from the session registry: scrollback blobs are the largest
 * payloads the daemon persists, and the registry is rewritten on every
 * session/status change — mixing the two would make every registry save
 * carry kilobytes of dead pane text.
 */

import { JsonStore } from "../json-store.js";

/** One worker's captured pane bytes (bytes at termination). */
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

const EMPTY: PersistedLogs = { version: STATE_VERSION, logs: {} };

export class ArchivedLogStore {
  private readonly store: JsonStore<PersistedLogs>;
  private logs: Record<string, ArchivedScrollback>;

  constructor(filePath: string) {
    this.store = new JsonStore(filePath);
    this.logs = this.store.load(validatePersistedLogs, EMPTY).logs;
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
