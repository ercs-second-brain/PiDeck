/**
 * Tests for the terminal theme (issues #299 + #376): the pane must use the
 * app surface (background/foreground = the app's --bg/--text), define the
 * full ANSI set cohesively (no accidental repeats, bright variants lighter
 * than their normal counterparts), keep ANSI black collapsed into the plate,
 * and stay a module constant (no runtime re-theming — the "colors move
 * around" root cause was per-cell contrast rewriting, so nothing here may
 * reintroduce dynamic color changes).
 */

import { describe, expect, it } from "vitest";
import { TERMINAL_THEME } from "./terminal-theme";

describe("terminal theme (issues #299 + #376)", () => {
  it("paints the terminal with the app surface, not a foreign black box", () => {
    expect(TERMINAL_THEME.background).toBe("#0f1216");
    expect(TERMINAL_THEME.foreground).toBe("#e6e2d8");
    expect(TERMINAL_THEME.cursor).toBe("#e6e2d8");
    expect(TERMINAL_THEME.cursorAccent).toBe("#0f1216");
    expect(TERMINAL_THEME.selectionBackground).toBe("rgba(76, 141, 255, 0.3)");
  });

  it("defines the full ANSI 16 without repeats", () => {
    const ansi = [
      TERMINAL_THEME.black,
      TERMINAL_THEME.red,
      TERMINAL_THEME.green,
      TERMINAL_THEME.yellow,
      TERMINAL_THEME.blue,
      TERMINAL_THEME.magenta,
      TERMINAL_THEME.cyan,
      TERMINAL_THEME.white,
      TERMINAL_THEME.brightBlack,
      TERMINAL_THEME.brightRed,
      TERMINAL_THEME.brightGreen,
      TERMINAL_THEME.brightYellow,
      TERMINAL_THEME.brightBlue,
      TERMINAL_THEME.brightMagenta,
      TERMINAL_THEME.brightCyan,
      TERMINAL_THEME.brightWhite,
    ];
    expect(ansi).toHaveLength(16);
    expect(new Set(ansi).size).toBe(16);
    for (const color of ansi) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("keeps bright variants lighter than their normal counterparts", () => {
    const pairs = [
      [TERMINAL_THEME.red, TERMINAL_THEME.brightRed],
      [TERMINAL_THEME.green, TERMINAL_THEME.brightGreen],
      [TERMINAL_THEME.yellow, TERMINAL_THEME.brightYellow],
      [TERMINAL_THEME.blue, TERMINAL_THEME.brightBlue],
      [TERMINAL_THEME.magenta, TERMINAL_THEME.brightMagenta],
      [TERMINAL_THEME.cyan, TERMINAL_THEME.brightCyan],
      [TERMINAL_THEME.black, TERMINAL_THEME.brightBlack],
      [TERMINAL_THEME.white, TERMINAL_THEME.brightWhite],
    ] as Array<[string, string]>;
    for (const [normal, bright] of pairs) {
      expect(parseInt(bright.slice(1, 3), 16) + parseInt(bright.slice(3, 5), 16) + parseInt(bright.slice(5, 7), 16)).toBeGreaterThan(
        parseInt(normal.slice(1, 3), 16) + parseInt(normal.slice(3, 5), 16) + parseInt(normal.slice(5, 7), 16),
      );
    }
  });

  it("collapses ANSI black into the plate so TUI black-fills don't paint stripes", () => {
    expect(TERMINAL_THEME.black).toBe(TERMINAL_THEME.background);
  });

  it("keeps every normal ANSI hue readable on the plate without contrast lifting", () => {
    // Issue #376: the palette must not rely on xterm's per-cell contrast
    // rewrite (the "colors move around" root cause), so each normal slot
    // that can appear as foreground text carries enough luminance distance
    // from the #0f1216 plate on its own. Luma distance >= ~0.15 in the
    // 0..1 sRGB-luma approximation used here.
    const plate = luma(TERMINAL_THEME.background);
    const textColors = [
      TERMINAL_THEME.red,
      TERMINAL_THEME.green,
      TERMINAL_THEME.yellow,
      TERMINAL_THEME.blue,
      TERMINAL_THEME.magenta,
      TERMINAL_THEME.cyan,
      TERMINAL_THEME.white,
      TERMINAL_THEME.brightBlack,
    ] as string[];
    for (const color of textColors) {
      expect(Math.abs(luma(color) - plate)).toBeGreaterThanOrEqual(0.15);
    }
  });

  it("keeps the terminal palette decoupled from product colors (agent TUIs own ANSI semantics)", () => {
    // Issue #376: the old theme mapped ANSI slots onto UI tokens (accent
    // red, issue blue, --text ramp grays). The slots are now a
    // standard-hue terminal palette, so product accents never masquerade
    // as output colors.
    expect(TERMINAL_THEME.red).not.toBe("#e05d44"); // app accent
    expect(TERMINAL_THEME.blue).not.toBe("#4c8dff"); // app issue blue
    expect(TERMINAL_THEME.brightBlack).not.toBe("#8b949e"); // --text-dim
    expect(TERMINAL_THEME.brightWhite).not.toBe("#e6e2d8"); // --text
  });
});

/** Perceptual-ish luma in 0..1 (Rec. 601 weights over gamma-encoded sRGB). */
function luma(hex: string | undefined): number {
  if (!hex) return 0;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
