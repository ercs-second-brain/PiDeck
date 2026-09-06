/**
 * Unit tests for the pure terminal frame-rendering logic (`screen.ts`):
 * capture splitting, scroll-preserving frame diffing, and full repaints.
 */

import { describe, expect, it } from "vitest";
import {
  frameUpdate,
  fullRepaint,
  screenRepaint,
  splitCapture,
  withSynchronizedUpdate,
} from "./screen.js";

describe("splitCapture", () => {
  it("splits history from the visible screen", () => {
    const raw = ["h1", "h2", "s1", "s2", "s3"].join("\n") + "\n";
    expect(splitCapture(raw, 3)).toEqual({
      history: ["h1", "h2"],
      screen: ["s1", "s2", "s3"],
    });
  });

  it("strips the trailing newline artifact", () => {
    expect(splitCapture("a\nb\n", 2).screen).toEqual(["a", "b"]);
  });

  it("pads short captures to the full screen height", () => {
    const split = splitCapture("only\n", 4);
    expect(split.screen).toEqual(["", "", "", "only"]);
    expect(split.history).toEqual([]);
  });
});

describe("frameUpdate", () => {
  it("returns empty for identical screens", () => {
    const screen = ["one", "two", "three"];
    expect(frameUpdate(screen, [...screen])).toBe("");
  });

  it("returns empty when both screens are empty", () => {
    expect(frameUpdate([], [])).toBe("");
  });

  it("rewrites a single changed row in place", () => {
    const update = frameUpdate(["a", "b", "c"], ["a", "B!", "c"]);
    expect(update).toBe("\x1b[2;1H\x1b[2KB!");
  });

  it("rewrites only the changed rows", () => {
    const update = frameUpdate(["a", "b", "c", "d"], ["A", "b", "C", "d"]);
    expect(update).toBe("\x1b[1;1H\x1b[2KA\x1b[3;1H\x1b[2KC");
  });

  it("emits a scroll-then-rewrite update for shifted content", () => {
    const update = frameUpdate(["a", "b", "c"], ["b", "c", "d"]);
    // Scroll 1 line at the bottom row, then rewrite the exposed bottom row.
    expect(update).toBe("\x1b[3;1H\r\n\x1b[3;1Hd");
  });

  it("handles multi-line scroll with several new lines", () => {
    const update = frameUpdate(["a", "b", "c", "d"], ["c", "d", "e", "f"]);
    expect(update).toBe("\x1b[4;1H\r\n\r\n\x1b[3;1He\r\nf");
  });

  it("rewrites every row when no scroll shift matches", () => {
    const update = frameUpdate(["a", "b"], ["x", "y"]);
    // k=1 would require next[0]===prev[1]; nothing matches → full rewrite.
    expect(update).toBe("\x1b[1;1H\x1b[2Kx\x1b[2;1H\x1b[2Ky");
  });

  it("scrolls maximally when the shifted content matches", () => {
    // k=2 matches (next[0]="a"===prev[2]); bottom two rows are rewritten.
    const update = frameUpdate(["a", "a", "a"], ["a", "b", "c"]);
    expect(update).toBe("\x1b[3;1H\r\n\r\n\x1b[2;1Hb\r\nc");
  });

  it("applying the emitted update to prev reproduces next exactly", () => {
    // Simulate a dumb client: apply positioning/scroll semantics manually.
    const prev = ["$ ls", "file1", "file2", "$ _"];
    const next = ["file1", "file2", "$ ls -la", "total 3", "$ _"];
    const update = frameUpdate(prev, next);
    expect(applyToScreen(prev, update, next.length)).toEqual(next);
  });
});

/**
 * Toy "terminal" that understands exactly the three operations the diff
 * renderer emits, to verify the frame protocol round-trips.
 */
function applyToScreen(screen: string[], update: string, rows: number): string[] {
  const lines = [...screen];
  let index = 0;
  while (index < update.length) {
    const move = /^\x1b\[(\d+);1H/.exec(update.slice(index));
    if (move) {
      const row = Number(move[1]) - 1;
      index += move[0].length;
      // After a move, an optional erase then content up to the next escape.
      const erase = update.slice(index, index + 4) === "\x1b[2K";
      if (erase) index += 4;
      const nextEscape = update.indexOf("\x1b[", index);
      const text = update.slice(index, nextEscape === -1 ? update.length : nextEscape);
      index += text.length;
      if (erase || text.length > 0 || lines[row] !== undefined) {
        while (lines.length <= row) lines.push("");
        lines[row] = text;
      }
      continue;
    }
    const newline = update.slice(index, index + 2) === "\r\n";
    if (newline) {
      index += 2;
      lines.push(""); // scrolls at any row in this toy model
      continue;
    }
    index++; // skip anything unrecognized (shouldn't happen)
  }
  while (lines.length > rows) lines.shift();
  return lines.slice(0, rows);
}

describe("fullRepaint / screenRepaint", () => {
  it("fullRepaint clears then streams history and screen", () => {
    const out = fullRepaint(["old"], ["a", "b"]);
    expect(out).toBe("\x1b[2J\x1b[Hold\r\na\r\nb");
  });

  it("screenRepaint clears then draws only the screen", () => {
    expect(screenRepaint(["a", "b"])).toBe("\x1b[2J\x1b[Ha\r\nb");
  });
});

describe("withSynchronizedUpdate", () => {
  it("wraps the update in DECSET 2026 markers", () => {
    expect(withSynchronizedUpdate("XYZ")).toBe("\x1b[?2026hXYZ\x1b[?2026l");
  });
});
