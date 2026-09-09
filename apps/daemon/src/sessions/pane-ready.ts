/**
 * Pane-input readiness probe (issue #318).
 *
 * pi's TUI (ink) drops or holds terminal input that arrives during its
 * startup window (~0.6–2s cold start, observed live): bytes typed into a
 * freshly created pane before the TUI mounts either vanish entirely or sit
 * unsubmitted in the input box with the submit Enter swallowed. A
 * `pane_current_command` probe only proves the pi process is running — the
 * #312 idempotence check — not that the TUI is accepting input, which is
 * why spawn-path prompts kept landing in that window.
 *
 * pi's stable "accepting input" marker is its input box: a full-width
 * horizontal-rule border rendered in the same paint pass as the status
 * footer (verified live against pi 0.85.1: a message typed once the border
 * is visible is submitted; one typed before it is not). This module turns
 * that observation into one idempotent, bounded wait shared by every
 * spawn-path prompt delivery (worker spawn, agent-kind question, pipeline
 * spawns, prompt-gate retries).
 */

import type { Tmux } from "./tmux.js";

/**
 * The trailing pane lines probed per readiness poll. pi's input box and
 * footer live in the bottom few rows; a bounded capture keeps the poll
 * O(1) regardless of scrollback depth.
 */
const PROBE_LINES = 12;

/** The input-box border: a horizontal rule wide enough to be TUI chrome. */
const BORDER = /─{10,}/;

/** True when a `capture-pane` payload shows pi's input box (ready state). */
export function paneInputReady(capture: string): boolean {
  return BORDER.test(capture);
}

export interface PaneReadyWaitOptions {
  /**
   * How long to wait for the pane to become ready. Generous by default:
   * pi's observed cold start is well under 2s, but plugin-heavy setups and
   * slow disks exist. `0` disables waiting (single probe).
   */
  timeoutMs?: number;
  /** Poll interval. Default 200ms — faster than the observed boot, cheap. */
  pollIntervalMs?: number;
}

/**
 * Waits (bounded) until the pane shows pi's ready state. Resolves `true`
 * when the input box is visible, `false` on timeout or when the pane dies
 * (tmux errors) — a `false` return means "unknown/unready", and callers
 * decide: the prompt-gate delivery paths still send (fail-open, today's
 * behavior; the send itself fails truthfully on a dead pane), spawn paths
 * queue on the gate instead. Never throws.
 */
export async function waitForPaneInputReady(tmux: Tmux, tmuxSession: string, options: PaneReadyWaitOptions = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      if (paneInputReady(await tmux.capturePane(tmuxSession, { lastLines: PROBE_LINES }))) return true;
    } catch {
      return false; // pane gone — never ready
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
