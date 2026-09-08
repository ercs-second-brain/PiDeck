/**
 * tmux command/name helpers behind the {@link SessionManager} facade
 * (extracted from `manager.ts`): POSIX-shell quoting, pane-command
 * (de)serialization, the reboot-resilient resurrection guard, and
 * daemon-managed tmux session name parse/sanitize (issues #4, #15, #27).
 */

import type { SessionRole } from "./registry.js";

/** Characters that are safe in a POSIX shell word without quoting. */
const SH_BARE_WORD = /^[A-Za-z0-9_./:=,+@%^-]+$/;

/** Single-quotes a word for the POSIX shell unless it is safe bare. */
export function shQuote(word: string): string {
  return SH_BARE_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Command launched in worker panes. The pi coding agent CLI runs interactively in the pane. */
export const DEFAULT_WORKER_COMMAND: string[] = ["pi"];

/**
 * Serializes a pane command argv into the `Session.command` contract field: a
 * POSIX-shell word string (e.g. `pi` or `bash -c 'sleep 300'`) that
 * {@link deserializeCommand} can parse back (issue #27).
 */
export function serializeCommand(command: string[]): string {
  return command.map(shQuote).join(" ");
}

/**
 * Parses a `Session.command` string back into argv. Best-effort POSIX-ish
 * splitting — whitespace-separated words with single-quote, double-quote and
 * backslash escaping — that round-trips {@link serializeCommand} exactly.
 */
export function deserializeCommand(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of command.trim()) {
    if (escaped) {
      current += ch;
      started = true;
      escaped = false;
      continue;
    }
    if (quote === null && ch === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote === null && (ch === " " || ch === "\t")) {
      if (started) {
        argv.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    if (quote !== null) {
      // Inside a quoted word: only the matching closing quote ends it.
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started || current !== "") argv.push(current);
  return argv;
}

/**
 * Wraps a pane command in the reboot-resilient shell guard: run the
 * recorded command verbatim when its binary is on PATH, else fall back to
 * an interactive shell so the pane survives a reboot/restart where the
 * agent binary may be missing (issue #15). Used by
 * {@link SessionManager.reconcile} to faithfully resurrect recorded spawn
 * commands (issue #27).
 */
export function resurrectionCommand(recorded: string[]): string[] {
  const bin = recorded[0] ?? "";
  return [
    "sh",
    "-c",
    `command -v ${shQuote(bin)} >/dev/null 2>&1 && exec ${recorded
      .map(shQuote)
      .join(" ")} || exec "\${SHELL:-/bin/sh}"`,
  ];
}

/**
 * Command used to resurrect a worker pane with no recorded command (see
 * {@link SessionManager.reconcile}): the {@link DEFAULT_WORKER_COMMAND}
 * guarded by {@link resurrectionCommand}.
 *
 * After a reboot/restart the agent binary may be missing; re-running the
 * agent verbatim would exit instantly and tmux would close the session,
 * making it un-attachable. Instead, run the agent when it is on PATH, else
 * fall back to an interactive shell so the pane survives and stays
 * re-attachable.
 */
export const RESURRECT_WORKER_COMMAND: string[] = resurrectionCommand(DEFAULT_WORKER_COMMAND);

/** Matches tmux session names created by `SessionManager`: `pideck-<projectId>-<role>-<n>`. */
const TMUX_NAME_PATTERN = /^pideck-(.+)-(orchestrator|worker)-(\d+)$/;

/**
 * Parses a daemon-managed tmux session name back into its parts. Note the
 * projectId is the *sanitized* segment (see {@link sanitizeTmuxSegment}); the
 * mapping back to the raw project id is lossy by design.
 */
export function parseTmuxSessionName(name: string): {
  projectId: string;
  role: SessionRole;
  n: number;
} | null {
  const match = TMUX_NAME_PATTERN.exec(name);
  if (!match) return null;
  return { projectId: match[1] ?? "", role: match[2] as SessionRole, n: Number(match[3]) };
}

/** Keeps a projectId safe for tmux session names (tmux forbids `.` and `:`). */
export function sanitizeTmuxSegment(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "project";
}
