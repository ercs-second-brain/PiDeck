/**
 * Tests for the shared files-changed view (issue #126): the clickable file
 * table + per-file patch navigation used by both the PR diff view and the
 * per-worker files-changed view. Pure views rendered with
 * `renderToString` (same pattern as the other component tests).
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { DiffFile } from "@agentskiss/shared";

import { DiffView, splitPatchSections } from "./DiffView";

const files: DiffFile[] = [
  { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1 },
  { filename: "src/new.ts", status: "added", additions: 2, deletions: 0 },
];

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "+const b = 2;",
  "-const c = 3;",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+export const a = 1;",
  "+export const b = 2;",
  "",
].join("\n");

function view(): string {
  return renderToString(
    <MemoryRouter>
      <DiffView files={files} patch={patch} />
    </MemoryRouter>,
  );
}

describe("DiffView", () => {
  it("lists every file with status and +/- stats", () => {
    const html = view();
    expect(html).toContain("src/a.ts");
    expect(html).toContain("src/new.ts");
    expect(html).toContain("badge-diff-added");
    expect(html).toContain("diff-add-count");
  });

  it("renders the whole patch by default (one section per file)", () => {
    const html = view();
    expect((html.match(/diff-file-header/g) ?? []).length).toBe(2);
    expect(html).toContain("+const b = 2;");
    expect(html).toContain("+export const b = 2;");
  });

  it("renders an empty-state note for a worker with no changes yet", () => {
    const html = renderToString(<DiffView files={[]} patch="" />);
    expect(html).toContain("No file changes.");
    expect(html).toContain("No changes.");
  });

  it("splits a patch into per-file sections on diff --git headers", () => {
    const sections = splitPatchSections(patch);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.[0]).toBe("diff --git a/src/a.ts b/src/a.ts");
    expect(sections[1]?.[0]).toBe("diff --git a/src/new.ts b/src/new.ts");
    expect(splitPatchSections("")).toEqual([]);
  });
});
