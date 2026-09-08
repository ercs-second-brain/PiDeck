import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { DiffFile, PullRequestDiff, WorkerFilesChanged } from "@agentskiss/shared";
import { apiGetPullRequestDiff, apiGetWorkerFilesChanged, errorMessage } from "../lib/api";
import { DiffView } from "../components/DiffView";

/**
 * Diff review view for one diff-route target. The route segment is either a
 * PR number (PR-centric view, unchanged) or a worker id — the per-worker
 * files-changed view (issue #126): the worker's PR files when one exists, or
 * its branch diff vs the project's default branch while work is mid-flight.
 * Both render through the shared {@link DiffView} with per-file navigation.
 */

/** Normalized payload for the shared diff rendering, whichever mode resolved. */
interface DiffPageModel {
  /** Page heading: `PR #9` or the worker id. */
  heading: string;
  /** Note after the heading: `diff` for PRs, `files changed` for workers. */
  note: string;
  /** Provenance of a worker's file list (`null` for PRs). */
  sourceNote: string | null;
  headBranch: string;
  baseBranch: string;
  files: DiffFile[];
  patch: string;
}

function isPrRef(ref: string): boolean {
  return /^\d+$/.test(ref);
}

function prModel(diff: PullRequestDiff): DiffPageModel {
  return {
    heading: `PR #${diff.prNumber}`,
    note: "diff",
    sourceNote: null,
    headBranch: diff.headBranch,
    baseBranch: diff.baseBranch,
    files: diff.files,
    patch: diff.patch,
  };
}

function workerModel(changed: WorkerFilesChanged): DiffPageModel {
  return {
    heading: changed.workerId,
    note: "files changed",
    sourceNote: changed.source === "pr" ? `via PR #${changed.prNumber}` : "branch diff — no PR yet",
    headBranch: changed.headBranch,
    baseBranch: changed.baseBranch,
    files: changed.files,
    patch: changed.patch,
  };
}

/** Fetches and normalizes the diff for the route target (PR number or worker id). */
function loadDiffModel(projectId: string, ref: string): Promise<DiffPageModel> {
  return isPrRef(ref)
    ? apiGetPullRequestDiff(projectId, Number(ref)).then(prModel)
    : apiGetWorkerFilesChanged(ref).then(workerModel);
}

export function DiffPage() {
  const { projectId, prNumber: ref } = useParams();
  const [model, setModel] = useState<DiffPageModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (projectId === undefined || ref === undefined) return;
    let cancelled = false;
    setModel(null);
    setError(null);
    loadDiffModel(projectId, ref)
      .then((result) => {
        if (!cancelled) setModel(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, ref]);

  // Title while loading, derived from the raw route segment (PR # or worker id).
  const loadingTitle = ref === undefined ? "Diff" : isPrRef(ref) ? `PR #${ref} diff` : `${ref} files changed`;

  return (
    <main className="page page-wide">
      <div className="board-header">
        <div>
          <h1 className="page-title">
            {model === null ? loadingTitle : model.heading}{" "}
            <span className="diff-title-note">{model === null ? "" : model.note}</span>
          </h1>
          {model !== null && (
            <span className="project-repo">
              <code>{model.headBranch}</code> → <code>{model.baseBranch}</code>
              {model.sourceNote !== null && <span className="diff-source-note"> · {model.sourceNote}</span>}
            </span>
          )}
        </div>
        <Link className="button" to={`/projects/${projectId ?? ""}`}>
          ← Board
        </Link>
      </div>

      {error !== null && <p className="error-note">Could not load diff: {error}</p>}
      {model === null && error === null && <p className="empty">Loading diff…</p>}

      {model !== null && <DiffView files={model.files} patch={model.patch} />}
    </main>
  );
}
