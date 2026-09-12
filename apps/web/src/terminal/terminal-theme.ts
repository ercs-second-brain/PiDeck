/**
 * The browser terminal's color theme: the pane shares the app's surface
 * (#0c0d10) and the 16 ANSI slots are agent-orchestrator's dark terminal
 * palette (One Dark-derived), per docs/DESIGN.md §2. The palette is a module
 * constant — the app is dark-only, and nothing re-themes the pane at runtime,
 * so output colors are stable over time and across contexts.
 *
 * `black` is collapsed into the background on purpose: a TUI that fills a row
 * with "black" draws an invisible band instead of a bar. `minimumContrastRatio`
 * stays at 1 (set on the terminal itself) so agent TUIs keep full control of
 * their own foreground/background pairs.
 */

import type { Terminal } from "@xterm/xterm";

export const TERMINAL_THEME: NonNullable<Terminal["options"]["theme"]> = {
  background: "#0c0d10",
  foreground: "#f4f5f7",
  cursor: "#f59f4c",
  cursorAccent: "#0c0d10",
  selectionBackground: "rgba(245, 159, 76, 0.3)",
  black: "#0c0d10",
  red: "#f05d5e",
  green: "#44c97a",
  yellow: "#e5c34b",
  blue: "#5b9cff",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#d7dae0",
  brightBlack: "#7f8792",
  brightRed: "#ff7b7c",
  brightGreen: "#62df91",
  brightYellow: "#f2d66d",
  brightBlue: "#79b1ff",
  brightMagenta: "#d99aee",
  brightCyan: "#79d4df",
  brightWhite: "#f4f5f7",
};