/**
 * Worker status → display-tone mapping (issue #112). Display-only: the
 * daemon's status semantics are untouched, this just decides the color and
 * pulse of the sidebar / workers-panel indicator.
 *
 * Colors: **blue** = working (spawning/running), **green** = PR is up or
 * ready again (awaiting CI / review on an open PR), **red** = fixing CI or
 * addressing review comments. Everything terminal or otherwise idle is
 * solid neutral. The agent is actively working while spawning/running and
 * while fixing/addressing — those tones pulse slowly; green (waiting on CI/
 * review) and the neutral tones stay solid.
 */

import type { WorkerStatus } from "@pideck/shared";

type WorkerStatusTone = "working" | "pr-ready" | "fixing" | "idle";

interface WorkerStatusIndicator {
  tone: WorkerStatusTone;
  /** Slow CSS pulse while the agent is actively working. */
  pulsing: boolean;
}

const WORKING: ReadonlySet<WorkerStatus> = new Set(["spawning", "running"]);
const FIXING: ReadonlySet<WorkerStatus> = new Set(["fixing_ci", "addressing_review"]);

export function workerStatusIndicator(status: WorkerStatus): WorkerStatusIndicator {
  if (WORKING.has(status)) return { tone: "working", pulsing: true };
  if (status === "awaiting_ci") return { tone: "pr-ready", pulsing: false };
  if (FIXING.has(status)) return { tone: "fixing", pulsing: true };
  // done / failed / stopped / archived: idle or terminal — solid neutral.
  return { tone: "idle", pulsing: false };
}

/** Class list for the indicator element: `worker-badge`- or `badge`-based. */
export function workerStatusClasses(status: WorkerStatus, baseClass: string): string {
  const { tone, pulsing } = workerStatusIndicator(status);
  return `${baseClass} status-indicator status-indicator-${tone}${pulsing ? " status-indicator-pulse" : ""}`;
}
