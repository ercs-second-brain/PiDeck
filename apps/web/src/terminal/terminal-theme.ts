/**
 * The browser terminal's color theme (issue #299): a tasteful, cohesive
 * dark ANSI palette derived from the app tokens (#0f1216 / #e05d44) so the
 * terminal reads as the same product as the UI around it. The derivation
 * rules live in ../../DESIGN.md ("Terminal theme"); this module is the
 * single source of truth for the values, consumed by TerminalPane's xterm
 * `theme` option.
 *
 * Derivation rules:
 * - background/foreground are the app's own `--bg` / `--text` values — the
 *   pane is literally the app surface, not a foreign black box;
 * - the 16 ANSI colors keep their standard hues (red, green, …) so tool
 *   output stays semantically readable, but each tone is desaturated and
 *   lightened to sit harmoniously on #0f1216; normal variants near
 *   `--text-dim` brightness, bright variants near `--text` brightness;
 * - the accent hue (#e05d44) owns `red` — errors and the app accent are
 *   the same color family;
 * - `blue`/`cyan` are kin to the app's issue (#4c8dff) and info hues;
 * - selection follows the app's hover/selected surface tone.
 */

import type { Terminal } from "@xterm/xterm";

/** Hex form of an app palette token, inlined so this module stays dependency-free. */
const APP = {
  bg: "#0f1216",
  bgHover: "#1c2330",
  text: "#e6e2d8",
  textDim: "#8b949e",
  accent: "#e05d44",
  issue: "#4c8dff",
  green: "#3fb950",
  amber: "#d29922",
  pr: "#b07cff",
} as const;

/**
 * The xterm theme: app surface + cohesive desaturated ANSI palette.
 * `bright` variants carry the standard hues lightened for emphasis; the
 * cursor uses the foreground (with `cursorAccent` matching the background)
 * so it reads without introducing a new color.
 */
export const TERMINAL_THEME: NonNullable<Terminal["options"]["theme"]> = {
  background: APP.bg,
  foreground: APP.text,
  cursor: APP.text,
  cursorAccent: APP.bg,
  selectionBackground: APP.bgHover,
  // App accent owns red (errors = accent family, issue #299).
  red: APP.accent,
  brightRed: "#f07a63",
  // Standard hues, desaturated/lightened for the dark app surface.
  green: APP.green,
  brightGreen: "#5fc96e",
  yellow: APP.amber,
  brightYellow: "#e3b23c",
  blue: APP.issue,
  brightBlue: "#6ea6ff",
  magenta: APP.pr,
  brightMagenta: "#c294ff",
  cyan: "#4cb8c4",
  brightCyan: "#6ecfda",
  // Grays: normal = text-dim tone, bright = text tone.
  black: "#232a33",
  brightBlack: APP.textDim,
  white: "#c9c5bb",
  brightWhite: APP.text,
};
