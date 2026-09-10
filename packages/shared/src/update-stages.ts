/**
 * The update shim's stage vocabulary (issue #397): install/lib/update.sh
 * writes one of these stage labels into its progress state file at each
 * step of `pideck update`, and both the daemon (liveness check) and the
 * webapp (banner text) interpret them — one shared copy instead of three
 * hand-synced ones.
 *
 * `updateApplyProgressSchema.stage` (rest.ts) deliberately stays a free
 * string: the shim writes the stage, so typing it would let shim and
 * consumers drift into a parse failure (documented justified seam).
 */

/** Human text for each shim stage; an unknown stage falls back to `update stage: <stage>`. */
export const UPDATE_STAGE_TEXT: Record<string, string> = {
  checking: "checking for updates",
  fetching: "fetching the new source",
  building: "rebuilding — installing dependencies and building (usually the longest step)",
  installing: "installing the new build",
  restarting: "restarting the daemon",
};

/**
 * Stages that END an apply cycle (issue #221): everything else written by
 * the shim means an apply is genuinely running right now — the daemon must
 * serve that fact instead of racing the shim's git/gh operations with its
 * own probes, and the webapp must not treat it as a phantom finished strip.
 */
export const TERMINAL_UPDATE_STAGES: ReadonlySet<string> = new Set(["done", "failed"]);

/** Whether `stage` ends an apply cycle (`done`/`failed`) — see {@link TERMINAL_UPDATE_STAGES}. */
export function isTerminalUpdateStage(stage: string): boolean {
  return TERMINAL_UPDATE_STAGES.has(stage);
}