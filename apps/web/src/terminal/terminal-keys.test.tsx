/**
 * Tests for the mobile terminal key row (issue #105): the pane renders a
 * button per touch-keyboard-missing key (Esc, Tab, Ctrl+C, four arrows)
 * between the terminal and the status bar, and the key map holds the exact
 * byte sequences (single control bytes, arrows as CSI sequences).
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

// TerminalPane imports the xterm browser modules; stub them so the pane
// component can be imported in a node test environment.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { TerminalPane } from "./TerminalPane";
import { TERMINAL_KEYS } from "./keys";

describe("terminal key row (issue #105)", () => {
  it("maps each key to the exact byte sequence sent to the pane", () => {
    expect(TERMINAL_KEYS.map((key) => [key.label, key.seq])).toEqual([
      ["Esc", "\x1b"],
      ["Tab", "\x09"],
      ["Ctrl+C", "\x03"],
      ["↑", "\x1b[A"],
      ["↓", "\x1b[B"],
      ["←", "\x1b[D"],
      ["→", "\x1b[C"],
    ]);
  });

  it("renders a button for Esc, Tab, Ctrl+C, and all four arrows", () => {
    const html = renderToString(<TerminalPane sessionId="sess-1" />);
    expect(html).toContain("terminal-keyrow");
    for (const key of TERMINAL_KEYS) {
      expect(html).toContain(`>${key.label}</button>`);
    }
    // Exactly one button per key — desktop sees none of this via CSS.
    expect(html.match(/class="terminal-key"/g)).toHaveLength(TERMINAL_KEYS.length);
  });

  it("sits inside the terminal pane between terminal and status bar", () => {
    const html = renderToString(<TerminalPane sessionId="sess-1" />);
    const container = html.indexOf("terminal-container");
    const keyRow = html.indexOf("terminal-keyrow");
    const statusbar = html.indexOf("terminal-statusbar");
    expect(keyRow).toBeGreaterThan(container);
    expect(statusbar).toBeGreaterThan(keyRow);
  });

  it("exposes accessible names for the arrow glyphs", () => {
    const html = renderToString(<TerminalPane sessionId="sess-1" />);
    expect(html).toContain('aria-label="Up arrow"');
    expect(html).toContain('aria-label="Down arrow"');
    expect(html).toContain('aria-label="Left arrow"');
    expect(html).toContain('aria-label="Right arrow"');
  });
});
