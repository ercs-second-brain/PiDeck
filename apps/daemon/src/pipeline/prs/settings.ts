/**
 * Worker-pipeline settings slice (issue #106): the daemon-wide toggles that
 * gate the PR loop's always-on behaviors. All default ON; the pipeline reads
 * them fresh on every decision so a toggle lands without a restart.
 */

import type { ProjectSettings } from "@pideck/shared";

export interface WorkerPipelineSettings {
  terminateOnMerge: boolean;
  autoFixCi: boolean;
  autoFixReviewComments: boolean;
  /** Auto review agent on green, unapproved PRs (issue #107). */
  autoReview: boolean;
}

/** All-ON fallback when no settings provider is injected (tests/legacy). */
export const DEFAULT_WORKER_PIPELINE_SETTINGS: WorkerPipelineSettings = {
  terminateOnMerge: true,
  autoFixCi: true,
  autoFixReviewComments: true,
  autoReview: true,
};

/**
 * Resolves the effective pipeline toggles for one project (issue #322):
 * an explicit per-project boolean wins; an unset/`null` per-project field
 * (or no project) inherits the daemon-wide setting; with neither, the all-ON
 * defaults apply. The pipeline unit wraps its settings provider with this —
 * every consumer (CI-fix, review comments, auto review, terminate-on-merge)
 * then sees the same resolution, read fresh per decision.
 */
export function resolvePipelineSettings(
  project: { settings: ProjectSettings } | undefined,
  global: WorkerPipelineSettings | undefined,
): WorkerPipelineSettings {
  const base = global ?? DEFAULT_WORKER_PIPELINE_SETTINGS;
  const perProject = project?.settings;
  if (perProject === undefined) return base;
  const pick = (override: boolean | null | undefined, fallback: boolean): boolean =>
    typeof override === "boolean" ? override : fallback;
  return {
    terminateOnMerge: pick(perProject.terminateOnMerge, base.terminateOnMerge),
    autoFixCi: pick(perProject.autoFixCi, base.autoFixCi),
    autoFixReviewComments: pick(perProject.autoFixReviewComments, base.autoFixReviewComments),
    autoReview: pick(perProject.autoReview, base.autoReview),
  };
}
