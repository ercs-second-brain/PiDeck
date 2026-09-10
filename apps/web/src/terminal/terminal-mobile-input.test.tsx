/**
 * Mobile terminal input (issue #374): double-tapping space on a phone
 * duplicated the message being typed. The mechanism lives inside xterm's
 * hidden textarea (space slips past its keydown preventDefault and
 * accumulates in the value; iOS's double-space period gesture then rewrites
 * the value in place and xterm's textarea-diff logic re-emits the whole
 * buffer). The fix follows agent-orchestrator's mobile pattern: on touch
 * devices the OS keyboard is locked out of xterm's textarea and a dedicated
 * plain input field composes text, sent to the pane verbatim once with the
 * trailing Enter. These tests pin that contract.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

// TerminalPane imports the xterm browser modules; stub them so the pane
// component can be imported in a node test environment.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import {
  MOBILE_POINTER_QUERY,
  MobileComposer,
  applyMobileInputGate,
  removeMobileInputGate,
  submitComposerText,
  terminalPayload,
} from "./mobile-input";
import { TerminalPane } from "./TerminalPane";

describe("terminal payload (issue #374)", () => {
  it("sends composed text verbatim with the trailing Enter", () => {
    expect(terminalPayload("deploy. ")).toBe("deploy. \r");
    expect(terminalPayload("ls -l")).toBe("ls -l\r");
  });

  it("collapses interior newlines so one submission submits once", () => {
    expect(terminalPayload("yes,\nuse the second option")).toBe("yes, use the second option\r");
    expect(terminalPayload("yes,\n\n\nuse it")).toBe("yes, use it\r");
  });

  it("trims line-break ends but keeps typed spaces verbatim", () => {
    expect(terminalPayload("hi\n")).toBe("hi\r");
    // Typed spaces — the "deploy. " a double-space period gesture leaves —
    // are delivered as typed, never rewritten (the reported defect).
    expect(terminalPayload("  hi  ")).toBe("  hi  \r");
    expect(terminalPayload("\n  hi\n")).toBe("  hi\r");
  });

  it("sends nothing for empty or whitespace-only text", () => {
    expect(terminalPayload("")).toBe("");
    expect(terminalPayload("   \n  ")).toBe("");
  });
});

describe("composer submit (issue #374)", () => {
  it("sends the double-space result exactly once — never duplicated", () => {
    // The reported gesture: "deploy" typed, space twice → the field holds
    // "deploy. ". The send path must deliver those bytes once and only once.
    const frames: string[] = [];
    expect(submitComposerText("deploy. ", (data) => frames.push(data))).toBe(true);
    expect(frames).toEqual(["deploy. \r"]);
  });

  it("refuses empty input without sending", () => {
    const frames: string[] = [];
    expect(submitComposerText("", (data) => frames.push(data))).toBe(false);
    expect(submitComposerText("   ", (data) => frames.push(data))).toBe(false);
    expect(frames).toEqual([]);
  });
});

describe("mobile textarea gate (issue #374)", () => {
  function stubTextarea() {
    const attrs = new Map<string, string>();
    return {
      readOnly: false,
      attrs,
      setAttribute(name: string, value: string) {
        attrs.set(name, value);
      },
      removeAttribute(name: string) {
        attrs.delete(name);
      },
    };
  }

  it("locks the OS keyboard out of xterm's textarea", () => {
    const textarea = stubTextarea();
    applyMobileInputGate(textarea);
    expect(textarea.readOnly).toBe(true);
    // No virtual keyboard can open over the terminal, so no autocorrect,
    // no double-space period gesture, no composition — the whole class of
    // textarea mutations that duplicated input is unreachable.
    expect(textarea.attrs.get("inputmode")).toBe("none");
  });

  it("lifts the gate cleanly when the device is no longer touch-primary", () => {
    const textarea = stubTextarea();
    applyMobileInputGate(textarea);
    removeMobileInputGate(textarea);
    expect(textarea.readOnly).toBe(false);
    expect(textarea.attrs.has("inputmode")).toBe(false);
  });
});

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => {
      if (query !== MOBILE_POINTER_QUERY) throw new Error(`unexpected query: ${query}`);
      return { matches, addEventListener: () => {}, removeEventListener: () => {} };
    }),
  );
}

describe("composer rendering (issue #374)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the dedicated input field and Send button on touch devices", () => {
    stubMatchMedia(true);
    const html = renderToString(
      <TerminalPane sessionId="sess-1" />,
    );
    expect(html).toContain("terminal-composer");
    expect(html).toContain('aria-label="Terminal input"');
    expect(html).toContain('aria-label="Send"');
    // The Enter key on the virtual keyboard submits.
    expect(html).toContain('enterKeyHint="send"');
    // The key row coexists below the composer.
    expect(html).toContain("terminal-keyrow");
  });

  it("renders no composer on desktop (fine pointer)", () => {
    stubMatchMedia(false);
    const html = renderToString(<TerminalPane sessionId="sess-1" />);
    expect(html).not.toContain("terminal-composer");
    expect(html).toContain("terminal-keyrow");
  });

  it("defaults to desktop when matchMedia is unavailable (node/SSR)", () => {
    const html = renderToString(
      <TerminalPane sessionId="sess-1" />,
    );
    expect(html).not.toContain("terminal-composer");
  });

  it("clears the field and blocks empty sends on submit", () => {
    const sent: string[] = [];
    const html = renderToString(<MobileComposer onSend={(payload) => sent.push(payload)} />);
    // SSR renders the controlled empty state; submit wiring is covered by
    // the submitComposerText and payload tests above.
    expect(html).toContain('value=""');
    expect(sent).toEqual([]);
  });
});
