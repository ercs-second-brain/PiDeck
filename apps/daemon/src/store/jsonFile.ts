import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";

/**
 * One JSON document on disk, loaded through a zod schema and written atomically
 * (temp file + rename). A missing file yields the given empty value; a file that
 * is not valid JSON or fails the schema throws — never a silent reset.
 */
export class JsonFile<T> {
  readonly path: string;

  constructor(path: string, private schema: z.ZodType<T>, private empty: T) {
    this.path = path;
  }

  load(): T {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return structuredClone(this.empty);
      }
      throw err;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`${this.path}: not valid JSON`);
    }

    const parsed = this.schema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`${this.path}: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  write(data: T): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}
