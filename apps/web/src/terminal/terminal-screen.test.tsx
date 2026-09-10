/**
 * Tests for the terminal mount structure (issue #258): the fit addon
 * measures the xterm mount element's parent border-box and subtracts only
 * the xterm element's own padding. The visual inset therefore lives on the
 * outer `.terminal-container` while xterm mounts into an unpadded inner
 * `.terminal-screen` — if the padded container ever becomes the mount box
 * again, fit proposes rows/cols for more space than is visible and the
 * screen (backgrounds + scrollbar) overflows the pane.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

// TerminalPane imports the xterm browser modules; stub them so the pane
// component can be imported in a node test environment.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { TerminalPane } from "./TerminalPane";

describe("terminal mount structure (issue #258)", () => {
  it("mounts xterm into an unpadded screen box inside the padded container", () => {
    const html = renderToString(<TerminalPane sessionId="sess-1" />);
    // Adjacency is the contract: the fit-measured element (the ref target,
    // `.terminal-screen`) is the immediate child of the padded
    // `.terminal-container`, so fit's parent measurement equals the visible
    // space exactly.
    expect(html).toContain('<div class="terminal-container"><div class="terminal-screen">');
  });

  it("renders exactly one fit-measurement screen per pane", () => {
    const html = renderToString(<TerminalPane sessionId="sess-1" />);
    expect(html.match(/class="terminal-screen"/g)).toHaveLength(1);
  });
});
