/**
 * Persisted per-project issue cursor (issue #50).
 *
 * Records the highest issue number the daemon has **processed** for a
 * project, saved as `<stateDir>/issue-cursor/<projectId>.json` (next to the
 * session registry and the `pr-tracker/` files). On watcher start the
 * wiring sweeps issues numbered strictly above the cursor through the
 * normal spawn matrix, so issues created while the daemon was down are
 * auto-spawned on the next start — without mass-spawning the pre-cursor
 * backlog (issues ≤ cursor are never re-considered).
 *
 * A project with **no cursor file** is a first-ever start: the wiring
 * baselines the current backlog and persists the cursor instead of
 * spawning (a brand-new project must not retro-spawn its existing issues).
 *
 * Persistence follows the {@link ../prs/tracker.ts | PRTracker} pattern:
 * JSON on disk, corrupt/missing file ⇒ no cursor (safe first-start
 * semantics rather than a crash).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const persistedSchema = z.object({
  version: z.literal(1),
  lastSeenIssueNumber: z.number().int().nonnegative(),
});

interface PersistedCursor {
  version: 1;
  lastSeenIssueNumber: number;
}

export class IssueCursor {
  private lastSeen: number | null;

  constructor(private readonly filePath: string) {
    this.lastSeen = this.load();
  }

  /** The persisted high-water mark, or `null` when the project has no cursor yet. */
  get lastSeenIssueNumber(): number | null {
    return this.lastSeen;
  }

  /**
   * Advances the cursor to `number` — a no-op when the current mark is
   * already ≥ `number` (the cursor only ever moves forward). Persists
   * immediately so a crash/restart never re-sweeps processed issues.
   */
  set(number: number): void {
    if (this.lastSeen !== null && number <= this.lastSeen) return;
    this.lastSeen = number;
    this.save();
  }

  /** Writes the current cursor to the JSON file. */
  private save(): void {
    const state: PersistedCursor = { version: 1, lastSeenIssueNumber: this.lastSeen ?? 0 };
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private load(): number | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return null; // no persisted cursor yet: first-ever start
    }
    try {
      const state = persistedSchema.parse(JSON.parse(raw));
      return state.lastSeenIssueNumber;
    } catch {
      return null; // corrupt file: fall back to first-ever start semantics
    }
  }
}
