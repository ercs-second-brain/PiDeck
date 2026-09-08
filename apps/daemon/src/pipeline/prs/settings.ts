/**
 * Worker-pipeline settings slice (issue #106): the daemon-wide toggles that
 * gate the PR loop's always-on behaviors. All default ON; the pipeline reads
 * them fresh on every decision so a toggle lands without a restart.
 */

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
