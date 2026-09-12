/**
 * Unit tests for the mobile composer packaging and the hidden-textarea gate.
 * Pure node.
 */

import { describe, expect, it, vi } from "vitest";
import {
  applyMobileInputGate,
  removeMobileInputGate,
  submitComposerText,
  terminalPayload,
  type GatableTextarea,
} from "./mobile-input";

describe("terminalPayload", () => {
  it("delivers composed text verbatim with the trailing Enter", () => {
    expect(terminalPayload("deploy. now")).toBe("deploy. now\r");
  });

  it("collapses interior line breaks to single spaces", () => {
    expect(terminalPayload("first\nsecond")).toBe("first second\r");
    expect(terminalPayload("a\r\n\r\nb")).toBe("a b\r");
  });

  it("strips line-break-only edges so a pasted newline adds no empty submission", () => {
    expect(terminalPayload("\n  \nhello\n")).toBe("hello\r");
  });

  it("preserves typed spaces, including the double-space period gesture", () => {
    expect(terminalPayload("done.  next")).toBe("done.  next\r");
  });

  it("sends nothing for whitespace-only input", () => {
    expect(terminalPayload("  \n\t ")).toBe("");
    expect(terminalPayload("")).toBe("");
  });
});

describe("submitComposerText", () => {
  it("sends exactly once and reports whether anything was sent", () => {
    const send = vi.fn();
    expect(submitComposerText("hi", send)).toBe(true);
    expect(send).toHaveBeenCalledExactlyOnceWith("hi\r");
    expect(submitComposerText("  ", send)).toBe(false);
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("mobile input gate", () => {
  it("locks the OS keyboard out of xterm's hidden textarea", () => {
    const textarea: GatableTextarea = {
      readOnly: false,
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    };
    applyMobileInputGate(textarea);
    expect(textarea.readOnly).toBe(true);
    expect(textarea.setAttribute).toHaveBeenCalledWith("inputmode", "none");
    removeMobileInputGate(textarea);
    expect(textarea.readOnly).toBe(false);
    expect(textarea.removeAttribute).toHaveBeenCalledWith("inputmode");
  });
});