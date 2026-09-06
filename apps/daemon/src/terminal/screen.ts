/**
 * Terminal frame rendering: turns tmux `capture-pane` output into escape
 * sequences a browser xterm.js client can apply.
 *
 * The bridge keeps a model of the pane's visible screen (one string per
 * row, exactly `rows` entries). Every poll compares a fresh capture against
 * the model and emits a *minimal-ish* update:
 *
 * - When the pane scrolled (bottom-aligned row match), the update first
 *   scrolls the client screen by k lines — which pushes the top k rows into
 *   the client's own scrollback, preserving pane history — then rewrites the
 *   newly exposed bottom rows.
 * - Otherwise, only rows whose content changed are rewritten in place with
 *   absolute cursor positioning.
 *
 * Because every emission is absolute (cursor positioning) or provably
 * scroll-equivalent, a client that applies each frame in order always ends
 * up showing exactly the current model. Replay-on-attach writes the full
 * captured scrollback + screen in one shot; subsequent frames then keep the
 * client in sync.
 *
 * This module is pure string manipulation — no tmux, no I/O — so the whole
 * rendering protocol is unit-testable (see `screen.test.ts`).
 */

/** Escape sequence wrapping an update in a synchronized (flicker-free) repaint. */
const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const CLEAR_SCREEN = "\x1b[2J\x1b[H";

/** Wraps a frame update so xterm.js paints it in one atomic step. */
export function withSynchronizedUpdate(update: string): string {
  return `${SYNC_START}${update}${SYNC_END}`;
}

export interface SplitCapture {
  /** Lines above the visible screen (oldest first). May be empty. */
  history: string[];
  /** The visible screen, exactly `rows` entries (top to bottom). */
  screen: string[];
}

/**
 * Splits a `capture-pane -p -e` payload into scrollback history and the
 * visible screen. tmux output ends with a trailing newline artifact and
 * always contains at least the full screen height; short captures are
 * defensively padded with blank rows at the top.
 */
export function splitCapture(raw: string, rows: number): SplitCapture {
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  while (lines.length < rows) lines.unshift("");
  const cut = Math.max(0, lines.length - rows);
  return { history: lines.slice(0, cut), screen: lines.slice(cut) };
}

/**
 * Computes the escape-sequence update transforming a client showing
 * `prev` into one showing `next` (both exactly `rows` rows).
 * Returns `""` when nothing changed.
 */
export function frameUpdate(prev: string[], next: string[]): string {
  const rows = next.length;
  const scroll = detectScroll(prev, next);
  if (scroll === 0) return "";
  if (scroll > 0) return scrollUpdate(rows, scroll, next);
  return rewriteUpdate(prev, next);
}

/**
 * Smallest k ≥ 0 such that `next[i] === prev[i + k]` for every surviving
 * row (i.e. the screen content shifted up by k lines), or -1 when no
 * bottom-aligned shift matches (caller falls back to row rewrites).
 */
function detectScroll(prev: string[], next: string[]): number {
  const rows = next.length;
  if (prev.length !== rows) return -1;
  outer: for (let k = 0; k < rows; k++) {
    for (let i = 0; i + k < rows; i++) {
      if (next[i] !== prev[i + k]) continue outer;
    }
    return k;
  }
  return -1;
}

/**
 * Scroll by k: blank newlines at the bottom row push the top k rows into
 * the client scrollback, then the exposed bottom rows are rewritten with
 * the k new lines. All positioning is absolute, so the result is exactly
 * `next` regardless of the previous cursor position.
 */
function scrollUpdate(rows: number, k: number, next: string[]): string {
  return (
    `\x1b[${rows};1H` +
    "\r\n".repeat(k) +
    `\x1b[${rows - k + 1};1H` +
    next.slice(rows - k).join("\r\n")
  );
}

/** Rewrites every changed row in place (absolute positioning + erase). */
function rewriteUpdate(prev: string[], next: string[]): string {
  let out = "";
  for (let i = 0; i < next.length; i++) {
    if (prev[i] !== next[i]) out += `\x1b[${i + 1};1H\x1b[2K${next[i]}`;
  }
  return out;
}

/**
 * Full replay (attach / reconnect): clear the screen, then stream the
 * captured scrollback followed by the screen. The lines scroll the client
 * naturally, so the client's visible screen ends up showing exactly
 * `screen` and its scrollback contains `history`.
 */
export function fullRepaint(history: string[], screen: string[]): string {
  return CLEAR_SCREEN + [...history, ...screen].join("\r\n");
}

/**
 * Screen-only repaint (e.g. after a resize): clears the visible screen and
 * redraws it, leaving the client's existing scrollback untouched.
 */
export function screenRepaint(screen: string[]): string {
  return CLEAR_SCREEN + screen.join("\r\n");
}
