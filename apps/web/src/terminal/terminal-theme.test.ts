/**
 * Tests for the terminal theme (issue #299): the pane must use the app
 * palette (background/foreground = the app's --bg/--text), define the full
 * ANSI set cohesively (no accidental repeats, bright variants distinct
 * from their normal counterparts), and keep the accent family on red.
 */

import { describe, expect, it } from "vitest";
import { TERMINAL_THEME } from "./terminal-theme";

describe("terminal theme (issue #299)", () => {
  it("paints the terminal with the app surface, not a foreign black box", () => {
    expect(TERMINAL_THEME.background).toBe("#0f1216");
    expect(TERMINAL_THEME.foreground).toBe("#e6e2d8");
    expect(TERMINAL_THEME.cursor).toBe("#e6e2d8");
    expect(TERMINAL_THEME.cursorAccent).toBe("#0f1216");
    expect(TERMINAL_THEME.selectionBackground).toBe("#1c2330");
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
    ] as Array<[string, string]>;
    for (const [normal, bright] of pairs) {
      expect(parseInt(bright.slice(1, 3), 16) + parseInt(bright.slice(3, 5), 16) + parseInt(bright.slice(5, 7), 16)).toBeGreaterThan(
        parseInt(normal.slice(1, 3), 16) + parseInt(normal.slice(3, 5), 16) + parseInt(normal.slice(5, 7), 16),
      );
    }
  });

  it("derives the semantic hues from the app palette", () => {
    // Accent family owns red (errors = accent family).
    expect(TERMINAL_THEME.red).toBe("#e05d44");
    // Issue/info blue and the UI greens/ambers carry their semantics.
    expect(TERMINAL_THEME.blue).toBe("#4c8dff");
    expect(TERMINAL_THEME.green).toBe("#3fb950");
    expect(TERMINAL_THEME.yellow).toBe("#d29922");
    // Grays stay in the app's text ramp.
    expect(TERMINAL_THEME.brightBlack).toBe("#8b949e");
    expect(TERMINAL_THEME.brightWhite).toBe("#e6e2d8");
  });
});
