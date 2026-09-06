/**
 * Unit tests for the unified-diff parser backing `PullRequestDiff.files`,
 * plus DiffService wiring against the fake gh runner.
 */

import { describe, expect, it } from "vitest";

import { parseUnifiedDiff } from "./diffs.js";

const SAMPLE = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "+const b = 2;",
  "-const c = 3;",
  " const d = 4;",
  "diff --git a/src/removed.ts b/src/removed.ts",
  "deleted file mode 100644",
  "--- a/src/removed.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-export const gone = true;",
  "diff --git a/src/added.ts b/src/added.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/added.ts",
  "@@ -0,0 +1,2 @@",
  "+export const added = 1;",
  "+export const added2 = 2;",
  "diff --git a/src/before.ts b/src/after.ts",
  "similarity index 90%",
  "rename from src/before.ts",
  "rename to src/after.ts",
  "--- a/src/before.ts",
  "+++ b/src/after.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/blob.bin b/blob.bin",
  "index 111..222 100644",
  "Binary files a/blob.bin and b/blob.bin differ",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("extracts per-file status and +/- counts", () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files).toEqual([
      { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1 },
      { filename: "src/removed.ts", status: "removed", additions: 0, deletions: 1 },
      { filename: "src/added.ts", status: "added", additions: 2, deletions: 0 },
      { filename: "src/after.ts", status: "renamed", additions: 1, deletions: 1 },
      { filename: "blob.bin", status: "modified", additions: 0, deletions: 0 },
    ]);
  });

  it("returns an empty list for an empty patch", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("does not count +++/--- header lines as changes", () => {
    const files = parseUnifiedDiff(
      ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "+one", "-two", ""].join("\n"),
    );
    expect(files[0]).toEqual({ filename: "x", status: "modified", additions: 1, deletions: 1 });
  });
});
