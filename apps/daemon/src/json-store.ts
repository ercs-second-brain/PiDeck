/**
 * Tiny JSON-file persistence used across the daemon (api stores, session
 * registry, PR tracker, issue cursor) under the daemon state dir.
 * Synchronous writes (the volumes are tiny); load failures fall back to
 * defaults rather than crashing the daemon.
 *
 * All writes are atomic (write temp + rename) so a crash mid-write can
 * never leave a half-written state file behind.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Persists `content` to `filePath` atomically (write temp + rename). */
export function atomicWrite(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

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
      console.error(`[agentskiss] corrupt state file ${this.filePath}; using defaults:`, err);
      return fallback;
    }
  }

  /** Persists `value` atomically (write temp + rename). */
  save(value: T): void {
    atomicWrite(this.filePath, `${JSON.stringify(value, null, 2)}\n`);
  }
}
