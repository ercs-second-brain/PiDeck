/**
 * Tiny JSON-file persistence used by the daemon's API stores (projects,
 * settings) under the daemon state dir. Synchronous writes (the volumes are
 * tiny); load failures fall back to defaults rather than crashing the daemon.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export class JsonStore<T> {
  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  /** Reads and validates the persisted value; returns `fallback` when absent/corrupt. */
  load(validate: (value: unknown) => T | undefined, fallback: T): T {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return fallback;
    }
    try {
      const parsed = validate(JSON.parse(raw) as unknown);
      return parsed ?? fallback;
    } catch (err) {
      console.error(`[api] corrupt state file ${this.filePath}; using defaults:`, err);
      return fallback;
    }
  }

  /** Persists `value` atomically (write temp + rename). */
  save(value: T): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tmp, this.filePath);
  }
}
