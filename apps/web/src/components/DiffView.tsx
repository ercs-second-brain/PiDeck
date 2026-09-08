import { useState } from "react";
import type { DiffFile } from "@pideck/shared";

/**
 * The files-changed body shared by the PR diff view and the per-worker
 * files-changed view (issue #126): a file table (path, status, +/- stats)
 * where clicking a row shows just that file's diff, and the unified patch —
 * all files at once, or the selected file's section only (per-file
 * navigation within the same view).
 */
export function DiffView({ files, patch }: { files: DiffFile[]; patch: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const sections = splitPatchSections(patch);
  // Both patch producers emit one `diff --git` section per file in the file
  // list's order; on a mismatch (unexpected patch shape) render everything.
  const paired = sections.length === files.length;
  const visible = paired && selected !== null ? sections.filter((_, index) => files[index]?.filename === selected) : sections;

  return (
    <>
      <table className="diff-files">
        <thead>
          <tr>
            <th>File</th>
            <th>Status</th>
            <th className="num">+adds</th>
            <th className="num">−dels</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr
              key={file.filename}
              className={`diff-file-row${file.filename === selected ? " diff-file-selected" : ""}`}
              title="Show this file's diff"
              onClick={() => setSelected((current) => (current === file.filename ? null : file.filename))}
            >
              <td className="diff-path">{file.filename}</td>
              <td>
                <span className={`badge badge-diff-${file.status}`}>{file.status}</span>
              </td>
              <td className="num diff-add-count">+{file.additions}</td>
              <td className="num diff-del-count">−{file.deletions}</td>
            </tr>
          ))}
          {files.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                No file changes.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {selected !== null && (
        <p className="diff-file-filter">
          Showing <code>{selected}</code> only ·{" "}
          <button type="button" className="link-button" onClick={() => setSelected(null)}>
            show all files
          </button>
        </p>
      )}

      <pre className="diff-patch">
        {patch.length === 0 ? (
          <span className="diff-line diff-context empty">No changes.</span>
        ) : (
          visible.flatMap((section, sectionIndex) =>
            section.map((line, lineIndex) => (
              <DiffLine key={`${sectionIndex}-${lineIndex}`} line={line} />
            )),
          )
        )}
      </pre>
    </>
  );
}

/** Splits a unified patch into per-file sections on `diff --git` headers. */
export function splitPatchSections(patch: string): string[][] {
  const sections: string[][] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) sections.push([line]);
    else sections[sections.length - 1]?.push(line);
  }
  return sections;
}

/** One colored line of the unified diff. */
export function DiffLine({ line }: { line: string }) {
  const className = diffLineClass(line);
  return <span className={`diff-line ${className}`}>{line.length === 0 ? " " : line}</span>;
}

function diffLineClass(line: string): string {
  if (line.startsWith("diff --git")) return "diff-file-header";
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  if (
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("rename ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("similarity ") ||
    line.startsWith("Binary files") ||
    line.startsWith("GIT binary patch")
  ) {
    return "diff-meta";
  }
  return "diff-context";
}
