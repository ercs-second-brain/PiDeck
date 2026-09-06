import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { PullRequestDiff } from "@agentskiss/shared";
import { apiGetPullRequestDiff, errorMessage } from "../lib/api";

/**
 * Diff review view: one PR's unified diff with per-file stats, rendered with
 * plain +/- line coloring (no diff library).
 */
export function DiffPage() {
  const { projectId, prNumber } = useParams();
  const [diff, setDiff] = useState<PullRequestDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (projectId === undefined || prNumber === undefined) return;
    let cancelled = false;
    setDiff(null);
    setError(null);
    apiGetPullRequestDiff(projectId, Number(prNumber))
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, prNumber]);

  return (
    <main className="page page-wide">
      <div className="board-header">
        <div>
          <h1 className="page-title">
            PR #{prNumber} <span className="diff-title-note">diff</span>
          </h1>
          {diff && (
            <span className="project-repo">
              <code>{diff.headBranch}</code> → <code>{diff.baseBranch}</code>
            </span>
          )}
        </div>
        <Link className="button" to={`/projects/${projectId ?? ""}`}>
          ← Board
        </Link>
      </div>

      {error !== null && <p className="error-note">Could not load diff: {error}</p>}
      {diff === null && error === null && <p className="empty">Loading diff…</p>}

      {diff !== null && (
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
              {diff.files.map((file) => (
                <tr key={file.filename}>
                  <td className="diff-path">{file.filename}</td>
                  <td>
                    <span className={`badge badge-diff-${file.status}`}>{file.status}</span>
                  </td>
                  <td className="num diff-add-count">+{file.additions}</td>
                  <td className="num diff-del-count">−{file.deletions}</td>
                </tr>
              ))}
              {diff.files.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No file changes.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <pre className="diff-patch">
            {diff.patch.length === 0 ? (
              <span className="diff-line diff-context empty">No changes.</span>
            ) : (
              diff.patch.split("\n").map((line, index) => <DiffLine key={index} line={line} />)
            )}
          </pre>
        </>
      )}
    </main>
  );
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
