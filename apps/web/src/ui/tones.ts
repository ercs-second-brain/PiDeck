import type { WorkerState } from "@pideck/shared";
import type { BadgeTone } from "./Badge";

/**
 * The eight daemon-derived worker states mapped to their pill tone and
 * display label (docs/DESIGN.md §3 sidebar colours).
 */
export const STATE_TONES: Record<WorkerState, BadgeTone> = {
  working: "blue",
  ci: "amber",
  fixing: "amber",
  in_review: "purple",
  addressing: "amber",
  ready: "green",
  blocked: "red",
  done: "dim",
};

export const STATE_LABELS: Record<WorkerState, string> = {
  working: "working",
  ci: "ci",
  fixing: "fixing",
  in_review: "in review",
  addressing: "addressing",
  ready: "ready",
  blocked: "blocked",
  done: "done",
};

export function stateBadge(state: WorkerState): { tone: BadgeTone; label: string } {
  return { tone: STATE_TONES[state], label: STATE_LABELS[state] };
}
