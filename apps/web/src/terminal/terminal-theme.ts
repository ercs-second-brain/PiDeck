/**
 * The browser terminal's color theme (issues #299 + #376): the pane keeps the
 * app's own surface (background/foreground are the app `--bg`/`--text`
 * tokens), but the 16 ANSI slots follow agent-orchestrator's rule that the
 * terminal palette is *independent* from product colors — "agent TUIs own
 * the semantic meaning of these slots" — so output colors match what the
 * same CLI looks like in a native terminal.
 *
 * What changed in #376 and why (root-caused against the "colors move
 * around" symptom):
 *
 * 1. `minimumContrastRatio` is 1 (= xterm's neutral default), not 4.5.
 *    xterm's contrast feature rewrites each cell's foreground per render to
 *    reach the target ratio against that cell's *local* background — so the
 *    same SGR color came out different depending on whether it sat on the
 *    default plate, inside a TUI highlight block, or under the selection.
 *    Every repaint of a colored block visibly shifted colors around. The
 *    palette below instead keeps every slot readable on `#0f1216` *without*
 *    any runtime rewriting (agent-orchestrator ships the same setting with
 *    exactly this rationale).
 * 2. The 16 ANSI colors are a standard-hue, One Dark–derived set
 *    (agent-orchestrator's dark terminal palette, whose plate `#101317` is
 *    a near-identical surface to `#0f1216`). The previous palette
 *    desaturated the normals down near `--text-dim` brightness and relied
 *    on the contrast rescue to lift them — the direct cause of both the
 *    washed-out look and the shifting. Here `black` collapses into the
 *    plate (TUIs that fill rows with ANSI black don't paint stripes) and
 *    `brightWhite` is a true near-white instead of the app text tone.
 * 3. Nothing re-themes the pane at runtime (the theme object is a module
 *    constant; the app is dark-only), so with the contrast rewrite off the
 *    palette is fully stable over time and across contexts.
 *
 * Rendering notes: bold text selects the bright variants (standard terminal
 * semantics, kept explicit); the pane runs the WebGL renderer with a canvas
 * fallback (see TerminalPane) so glyphs rasterize on a fixed cell grid.
 */

import type { Terminal } from "@xterm/xterm";

/** Hex form of an app palette token, inlined so this module stays dependency-free. */
const APP = {
  bg: "#0f1216",
  bgHover: "#1c2330",
  text: "#e6e2d8",
} as const;

/**
 * The xterm theme: app surface + agent-orchestrator's dark ANSI palette.
 * The cursor uses the foreground (with `cursorAccent` matching the
 * background) so it reads without introducing a new color; selection is a
 * translucent wash of the app's issue blue so selected text keeps its own
 * colors instead of sitting on an opaque slab.
 */
export const TERMINAL_THEME: NonNullable<Terminal["options"]["theme"]> = {
  background: APP.bg,
  foreground: APP.text,
  cursor: APP.text,
  cursorAccent: APP.bg,
  selectionBackground: "rgba(76, 141, 255, 0.3)",
  // ANSI black = the plate itself: TUIs that fill rows with black don't
  // paint a darker stripe on the app surface (agent-orchestrator's rule).
  black: APP.bg,
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
