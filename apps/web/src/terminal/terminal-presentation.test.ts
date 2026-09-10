/**
 * Deep-design coherence pass (terminal surface): source-contract tests for
 * the CSS that makes the mobile composer (#374), key row (#105), status
 * bar, and touch-scroll (#375) read as one system, and that keeps the
 * sidebar's icon buttons and collapsed rail sized off one grid. The rules
 * live in terminal.css (source contracts, same pattern as
 * picker-row-layout.test.tsx).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The terminal.css source (relative to this test file). */
const css = readFileSync(fileURLToPath(new URL("./terminal.css", import.meta.url)), "utf8");

/** The first `selector { … }` block in the CSS source, if present. */
function cssBlock(selector: string, haystack: string = css): string {
  const block = haystack.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1];
  if (block === undefined) throw new Error(`missing CSS block for ${selector}`);
  return block;
}

describe("pane bottom bars read as one system (composer #374 + key row #105 + status bar)", () => {
  it("the key row shows wherever the composer shows: coarse pointer at any width, plus the phone breakpoint", () => {
    // The composer/touch-scroll gate on (pointer: coarse); the key row must
    // match (a coarse tablet otherwise got a composer with no keys).
    const keyrowQuery = css.match(/@media \(max-width: 768px\), \(pointer: coarse\)\s*\{[^@]*\.terminal-keyrow/);
    expect(keyrowQuery).not.toBeNull();
  });

  it("the safe-area home-indicator inset is owned by the status bar alone", () => {
    // The key row sits above the status bar — no second inset.
    const keyrowMedia = css.slice(css.indexOf("@media (max-width: 768px), (pointer: coarse)"));
    const keyrowBlock = cssBlock(".terminal-keyrow", keyrowMedia);
    expect(keyrowBlock).toContain("display: flex");
    expect(keyrowBlock).not.toContain("safe-area-inset-bottom");
    // The composer's inline safe-area padding is overridden (frozen module,
    // mobile-input.tsx — !important is the only way past an inline style).
    expect(css.match(/\.terminal-composer\s*\{[^}]*padding-bottom:\s*6px\s*!important/)).not.toBeNull();
  });

  it("the composer input keeps the 16px touch font (no iOS focus zoom)", () => {
    const coarse = css.slice(css.lastIndexOf("@media (pointer: coarse)"));
    expect(cssBlock(".terminal-composer-input", coarse)).toContain("font-size: var(--fs-lg)");
  });

  it("the status bar matches the bars above it wherever the key row shows (8px side rhythm)", () => {
    const keyrowMedia = css.slice(css.indexOf("@media (max-width: 768px), (pointer: coarse)"));
    expect(cssBlock(".terminal-statusbar", keyrowMedia)).toContain(
      "padding: 4px 8px calc(4px + env(safe-area-inset-bottom, 0px))",
    );
  });

  it("key buttons take accent on hover and active alike", () => {
    const keyrowMedia = css.slice(css.indexOf("@media (max-width: 768px), (pointer: coarse)"));
    expect(cssBlock(".terminal-key:hover", keyrowMedia)).toContain("border-color: var(--accent)");
    expect(cssBlock(".terminal-key:active", keyrowMedia)).toContain("border-color: var(--accent)");
  });
});

describe("sidebar icon buttons are one system", () => {
  it("the row ⋯ menu toggle shares the 26px icon-button box of the chat/⋯ controls", () => {
    expect(cssBlock(".picker-row-menu-toggle")).toContain("width: 26px");
    expect(cssBlock(".picker-project-chat,\n.picker-project-menu")).toContain("width: 26px");
  });
});

describe("collapsed desktop rail exactly fits its toggle", () => {
  it("rail width = padding + toggle + padding (4px + 26px + 4px)", () => {
    const rail = css.slice(css.indexOf("@media (min-width: 769px)"));
    expect(cssBlock(".app:not(.sidebar-open) .session-picker", rail)).toContain("width: 34px");
    expect(cssBlock(".app:not(.sidebar-open) .picker-scroll", rail)).toContain("padding: 4px");
  });
});
