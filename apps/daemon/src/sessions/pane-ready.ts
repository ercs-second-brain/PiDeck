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

/**
 * The composer content: whatever sits between the last two border lines
 * (the draft pi renders there). Empty when no input box is rendered — a
 * plain shell pane has no composer, so a visible message IS the transcript.
 */
export function paneInputArea(capture: string): string {
  const lines = capture.split("\n");
  const borders: number[] = [];
  lines.forEach((line, i) => {
    if (BORDER.test(line)) borders.push(i);
  });
  if (borders.length < 2) return "";
  return lines.slice(borders[borders.length - 2]! + 1, borders[borders.length - 1]!).join("\n");
}

/**
 * Whether a typed prompt has actually been submitted inside pi (issue
 * #318, the agent-orchestrator `confirmActive` evidence): the text shows
 * up OUTSIDE the composer — in the transcript — and no longer sits in the
 * input box. A draft still rendered between the borders (Enter swallowed
 * by the startup window) is not submitted; text visible in a pane without
 * a composer (plain shell) is. Newline-insensitive: an 80-col pane wraps
 * mid-token, and a wrap only inserts newlines, not characters.
 */
export function paneSubmitted(capture: string, text: string): boolean {
  const flat = capture.replace(/\n/g, "");
  if (!flat.includes(text)) return false;
  return !paneInputArea(capture).replace(/\n/g, "").includes(text);
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

/** Options for {@link confirmPaneSubmitted}. */
export interface PaneSubmitConfirmOptions {
  /** Total confirmation budget. Default 4s across polls + nudges. */
  timeoutMs?: number;
  /** Poll interval. Default 100ms. */
  pollIntervalMs?: number;
  /**
   * Enter-only re-submission budget (agent-orchestrator's `confirmActive`
   * pattern): the prompt text is typed exactly ONCE; when acceptance
   * evidence is missing, only a bare Enter is re-sent — a doubled message
   * is impossible by construction. Default 2.
   */
  maxEnterNudges?: number;
  /** Minimum spacing between Enter nudges. Default 1_500ms. */
  nudgeIntervalMs?: number;
}

/**
 * Bounded submit confirmation for a prompt just typed with its Enter:
 * polls until {@link paneSubmitted} accepts it; when the Enter was
 * swallowed (the message sits in the composer), re-sends bare Enters up to
 * `maxEnterNudges` times. Resolves `true` on acceptance, `false` when the
 * budget is exhausted (the draft stays visible in the composer — never
 * re-typed). Never throws; a dead pane is simply never submitted.
 *
 * For freshly created panes only: a pane that has been interacted with
 * may show a permission dialog, and a bare Enter would answer it — those
 * sends must not confirm (the daemon has no blocked-state signal to gate
 * on; agent-orchestrator does, via its managed pi extension hooks).
 */
export async function confirmPaneSubmitted(
  tmux: Tmux,
  tmuxSession: string,
  text: string,
  options: PaneSubmitConfirmOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 4_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const maxEnterNudges = options.maxEnterNudges ?? 2;
  const nudgeIntervalMs = options.nudgeIntervalMs ?? 1_500;
  const deadline = Date.now() + timeoutMs;
  let nudges = 0;
  let lastNudgeAt = 0;
  while (true) {
    try {
      if (paneSubmitted(await tmux.capturePane(tmuxSession, { lastLines: 30 }), text)) return true;
      const now = Date.now();
      // Space nudges out (each needs its own acceptance window), and never
      // so late that the last nudge's window falls past the deadline.
      if (nudges < maxEnterNudges && now - lastNudgeAt >= nudgeIntervalMs && now + nudgeIntervalMs < deadline) {
        nudges += 1;
        lastNudgeAt = now;
        await tmux.run(["send-keys", "-t", tmuxSession, "Enter"]);
      }
    } catch {
      return false; // pane gone — nothing to confirm
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
