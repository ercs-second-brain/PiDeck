/**
 * Unit tests for the terminal key row data and the sticky Ctrl mapping.
 * Pure node.
 */

import { describe, expect, it } from "vitest";
import { controlSeq, TERMINAL_KEYS } from "./keys";

describe("TERMINAL_KEYS", () => {
  it("covers the keys a touch keyboard lacks", () => {
    expect(TERMINAL_KEYS.map((key) => key.label)).toEqual([
      "Esc",
      "Tab",
      "↑",
      "↓",
      "←",
      "→",
      "⏎",
    ]);
    expect(TERMINAL_KEYS.map((key) => key.seq)).toEqual([
      "\x1b",
      "\x09",
      "\x1b[A",
      "\x1b[B",
      "\x1b[D",
      "\x1b[C",
      "\r",
    ]);
  });
});

describe("controlSeq", () => {
  it("maps letters to their C0 control byte", () => {
    expect(controlSeq("c")).toBe("\x03");
    expect(controlSeq("C")).toBe("\x03");
    expect(controlSeq("a")).toBe("\x01");
    expect(controlSeq("z")).toBe("\x1a");
  });

  it("maps the punctuation C0 range @ [ \\ ] ^ _", () => {
    expect(controlSeq("@")).toBe("\x00");
    expect(controlSeq("[")).toBe("\x1b");
    expect(controlSeq("\\")).toBe("\x1c");
    expect(controlSeq("]")).toBe("\x1d");
    expect(controlSeq("^")).toBe("\x1e");
    expect(controlSeq("_")).toBe("\x1f");
  });

  it("maps space to NUL (Ctrl+Space)", () => {
    expect(controlSeq(" ")).toBe("\x00");
  });

  it("returns null for non-control keys", () => {
    expect(controlSeq("1")).toBeNull();
    expect(controlSeq("Enter")).toBeNull();
    expect(controlSeq("")).toBeNull();
  });
});