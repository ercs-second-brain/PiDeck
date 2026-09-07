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

import { z } from "zod";

import { JsonStore } from "../../json-store.js";

const persistedSchema = z.object({
  version: z.literal(1),
  lastSeenIssueNumber: z.number().int().nonnegative(),
});

/** In-memory representation; `null` = no cursor yet (first-ever start). */
interface PersistedCursor {
  version: 1;
  lastSeenIssueNumber: number | null;
}

export class IssueCursor {
  private lastSeen: number | null;
  private readonly store: JsonStore<PersistedCursor>;

  constructor(filePath: string) {
    this.store = new JsonStore(filePath);
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

  /** Writes the current cursor to the JSON file (atomic via {@link JsonStore}). */
  private save(): void {
    const state: PersistedCursor = { version: 1, lastSeenIssueNumber: this.lastSeen ?? 0 };
    this.store.save(state);
  }

  /** Missing/corrupt file ⇒ `null` (first-ever start semantics, not a crash). */
  private load(): number | null {
    const state = this.store.load((value) => {
      const parsed = persistedSchema.safeParse(value);
      return parsed.success
        ? { version: 1, lastSeenIssueNumber: parsed.data.lastSeenIssueNumber }
        : undefined;
    }, { version: 1, lastSeenIssueNumber: null });
    return state.lastSeenIssueNumber;
  }
}
