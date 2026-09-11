/**
 * Unit tests for the pure terminal frame-rendering logic (`screen.ts`):
 * capture splitting, scroll-preserving frame diffing, and full repaints.
 *
 * The toy client models SGR state the way a real xterm parser does — EL/ED
 * fills use the *current* background and written cells inherit whatever
 * background is active at write time. A text-only toy client is exactly the
 * blind spot that let issue #442's background bugs through.
 */

import { describe, expect, it } from "vitest";
import {
  cursorSequence,
  frameUpdate,
  fullRepaint,
  screenRepaint,
  splitCapture,
  withSynchronizedUpdate,
  type CursorState,
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
    expect(update).toBe("\x1b[2;1H\x1b[0m\x1b[2KB!");
  });

  it("rewrites only the changed rows", () => {
    const update = frameUpdate(["a", "b", "c", "d"], ["A", "b", "C", "d"]);
    expect(update).toBe("\x1b[1;1H\x1b[0m\x1b[2KA\x1b[3;1H\x1b[0m\x1b[2KC");
  });

  it("emits a scroll-then-rewrite update for shifted content", () => {
    const update = frameUpdate(["a", "b", "c"], ["b", "c", "d"]);
    // Scroll 1 line at the bottom row, then rewrite the exposed bottom row.
    expect(update).toBe("\x1b[0m\x1b[3;1H\r\n\x1b[3;1Hd");
  });

  it("handles multi-line scroll with several new lines", () => {
    const update = frameUpdate(["a", "b", "c", "d"], ["c", "d", "e", "f"]);
    expect(update).toBe("\x1b[0m\x1b[4;1H\r\n\r\n\x1b[3;1He\r\nf");
  });

  it("rewrites every row when no scroll shift matches", () => {
    const update = frameUpdate(["a", "b"], ["x", "y"]);
    // k=1 would require next[0]===prev[1]; nothing matches → full rewrite.
    expect(update).toBe("\x1b[1;1H\x1b[0m\x1b[2Kx\x1b[2;1H\x1b[0m\x1b[2Ky");
  });

  it("scrolls maximally when the shifted content matches", () => {
    // k=2 matches (next[0]="a"===prev[2]); bottom two rows are rewritten.
    const update = frameUpdate(["a", "a", "a"], ["a", "b", "c"]);
    expect(update).toBe("\x1b[0m\x1b[3;1H\r\n\r\n\x1b[2;1Hb\r\nc");
  });

  it("applying the emitted update to prev reproduces next exactly", () => {
    // Simulate a client: apply positioning/scroll/erase semantics manually.
    const prev = ["$ ls", "file1", "file2", "$ _"];
    const next = ["file1", "file2", "$ ls -la", "total 3", "$ _"];
    const update = frameUpdate(prev, next);
    expect(applyToScreen(prev, update, next.length)).toEqual(next);
  });
});

interface ToyCell {
  readonly ch: string;
  /** Active background when the cell was written (`null` = default). */
  readonly bg: string | null;
}

/**
 * Toy "terminal" that models exactly the operations the diff renderer emits,
 * with the parser state a real xterm maintains: SGR (background) persists
 * across positioning and newlines, EL/ED erase fills with the current
 * background, scrolled-in blank rows take the current background, and
 * written cells inherit whatever background is active at write time.
 * Printable text past the last column defers its wrap like xterm.
 */
class ToyTerminal {
  private readonly screen: ToyCell[][];
  private r = 0;
  private c = 0;
  private pendingWrap = false;
  private bg: string | null = null;

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.screen = Array.from({ length: rows }, () => this.blankRow());
  }

  private blankRow(bg: string | null = null): ToyCell[] {
    return Array.from({ length: this.cols }, () => ({ ch: " ", bg }));
  }

  write(data: string): void {
    let i = 0;
    while (i < data.length) {
      const consumed = this.sequence(data.slice(i));
      if (consumed > 0) {
        i += consumed;
        continue;
      }
      if (this.pendingWrap) {
        this.lineFeed();
        this.pendingWrap = false;
      }
      this.screen[this.r]![this.c] = { ch: data[i] ?? " ", bg: this.bg };
      this.c++;
      if (this.c >= this.cols) this.pendingWrap = true;
      i += 1;
    }
  }

  /** Handles one escape sequence; returns the bytes consumed, 0 if none matched. */
  private sequence(rest: string): number {
    const cup = /^\x1b\[(\d+);1H/.exec(rest);
    if (cup) {
      this.r = Number(cup[1]) - 1;
      this.c = 0;
      this.pendingWrap = false;
      return cup[0].length;
    }
    if (rest.startsWith("\x1b[0m") || rest.startsWith("\x1b[49m")) {
      this.bg = null;
      return rest[2] === "0" ? 4 : 5;
    }
    const sgrBg = /^\x1b\[48;2;(\d+);(\d+);(\d+)m/.exec(rest);
    if (sgrBg) {
      this.bg = `${sgrBg[1]};${sgrBg[2]};${sgrBg[3]}`;
      return sgrBg[0].length;
    }
    if (rest.startsWith("\x1b[2K")) {
      const row = this.screen[this.r]!;
      for (let x = 0; x < this.cols; x++) row[x] = { ch: " ", bg: this.bg };
      return 4;
    }
    if (rest.startsWith("\x1b[2J")) {
      for (let y = 0; y < this.rows; y++) this.screen[y] = this.blankRow(this.bg);
      return 4;
    }
    if (rest.startsWith("\x1b[H")) {
      this.r = 0;
      this.c = 0;
      this.pendingWrap = false;
      return 3;
    }
    if (rest.startsWith("\r\n")) {
      this.lineFeed();
      return 2;
    }
    // Any other escape sequence: skip (our emissions never rely on it).
    const other = /^\x1b\[[-?0-9;]*[ -/]*[@-~]/.exec(rest);
    return other ? other[0].length : 0;
  }

  private lineFeed(): void {
    if (this.r === this.rows - 1) {
      this.screen.shift();
      this.screen.push(this.blankRow(this.bg));
    } else {
      this.r++;
    }
    this.c = 0;
    this.pendingWrap = false;
  }

  /** The row's text, trailing blanks trimmed. */
  text(row: number): string {
    return this.screen[row]!.map((cell) => cell.ch).join("").trimEnd();
  }

  /** Per-cell background of a row (`null` = terminal default). */
  bgs(row: number): (string | null)[] {
    return this.screen[row]!.map((cell) => cell.bg);
  }
}

/** Applies an update to `prev` the way the toy client would, as text rows. */
function applyToScreen(prev: string[], update: string, rows: number): string[] {
  const term = new ToyTerminal(80, rows);
  for (let i = 0; i < Math.min(prev.length, rows); i++) {
    term.write(`\x1b[${i + 1};1H\x1b[0m\x1b[2K${prev[i]}`);
  }
  term.write(update);
  return Array.from({ length: rows }, (_, i) => term.text(i));
}

describe("fullRepaint / screenRepaint", () => {
  it("fullRepaint resets SGR, clears, then streams history and screen", () => {
    const out = fullRepaint(["old"], ["a", "b"]);
    expect(out).toBe("\x1b[0m\x1b[2J\x1b[Hold\r\na\r\nb");
  });

  it("screenRepaint resets SGR, clears, then draws only the screen", () => {
    expect(screenRepaint(["a", "b"])).toBe("\x1b[0m\x1b[2J\x1b[Ha\r\nb");
  });
});

describe("withSynchronizedUpdate", () => {
  it("wraps the update in DECSET 2026 markers", () => {
    expect(withSynchronizedUpdate("XYZ")).toBe("\x1b[?2026hXYZ\x1b[?2026l");
  });
});

describe("cursorSequence", () => {
  const at = (x: number, y: number, visible = true): CursorState => ({ visible, x, y });

  it("emits the full state when the client state is unknown", () => {
    expect(cursorSequence(at(10, 3), null)).toBe("\x1b[?25h\x1b[4;11H");
    expect(cursorSequence(at(0, 0, false), null)).toBe("\x1b[?25l");
  });

  it("returns empty when the state is already in effect", () => {
    expect(cursorSequence(at(10, 3), at(10, 3))).toBe("");
    expect(cursorSequence(at(10, 3, false), at(10, 3, false))).toBe("");
  });

  it("moves a visible cursor with an absolute CUP", () => {
    expect(cursorSequence(at(0, 5), at(10, 3))).toBe("\x1b[6;1H");
  });

  it("hides and shows without relying on position while hidden", () => {
    expect(cursorSequence(at(10, 3, false), at(10, 3))).toBe("\x1b[?25l");
    expect(cursorSequence(at(10, 3), at(10, 3, false))).toBe("\x1b[?25h\x1b[4;11H");
    expect(cursorSequence(at(0, 0, false), at(10, 3, false))).toBe("");
  });
});

/**
 * Background-color scenarios shaped like the real pi 0.85.1 transcript that
 * reproduced issue #442: green action chips (`48;2;40;50;40`), red failed-tool
 * chips (`48;2;60;40;40`), and full-width chip bars. `-N` captures keep each
 * row's trailing cells, so rows are self-describing; the SGR resets keep the
 * client parser from plating rows with a stale background.
 */
describe("SGR backgrounds (issue #442)", () => {
  const COLS = 12;
  const ROWS = 5;
  const GREEN = "40;50;40";
  const RED = "60;40;40";

  /** Full-width background bar (e.g. pi's separator/task-box rows). */
  const bar = (bg: string): string => `\x1b[48;2;${bg}m${" ".repeat(COLS)}`;
  /** Action-chip row: ` cmd ` on the chip bg, rest of the row default. */
  const chip = (cmd: string): string =>
    `\x1b[48;2;${GREEN}m ${cmd} \x1b[0m${" ".repeat(Math.max(0, COLS - cmd.length - 2))}`;
  const pad = (s: string): string => s + " ".repeat(Math.max(0, COLS - s.length));
  const allBg = (bg: string | null): (string | null)[] => Array(COLS).fill(bg);

  it("attach: full-width bg bars render full-width; plain rows stay plain", () => {
    const term = new ToyTerminal(COLS, ROWS);
    term.write(fullRepaint([], [pad("head"), bar(GREEN), chip("read.txt"), pad("plain"), pad("tail")]));
    expect(term.bgs(1)).toEqual(allBg(GREEN));
    expect(term.bgs(2)).toEqual([...Array(10).fill(GREEN), null, null]);
    expect(term.bgs(3)).toEqual(allBg(null));
  });

  it("in-place rewrite after a chip/bar frame keeps each row's own background", () => {
    const term = new ToyTerminal(COLS, ROWS);
    const prev = [pad("head"), chip("echo hi"), pad("STATUS: running"), pad(""), bar(RED)];
    term.write(fullRepaint([], prev)); // frame paints down to a red bar: parser bg is red
    const next = [prev[0]!, chip("echo hi!"), pad("STATUS: done"), ...prev.slice(3)];
    term.write(frameUpdate(prev, next));
    // The chip row: green chip cells, default trailing cells (not red-plated).
    expect(term.bgs(1)).toEqual([...Array(10).fill(GREEN), null, null]);
    // The plain STATUS row: no background at all (F1: it used to inherit).
    expect(term.bgs(2)).toEqual(allBg(null));
    expect(term.text(2)).toBe("STATUS: done");
  });

  it("a bar row rewritten as the only change paints full-width regardless of parser state", () => {
    const term = new ToyTerminal(COLS, ROWS);
    const prev = [pad(""), pad(""), pad(""), pad(""), bar(RED)];
    term.write(fullRepaint([], prev)); // parser bg is red at frame end
    const next = [...prev.slice(0, 4), bar(GREEN)];
    term.write(frameUpdate(prev, next));
    // With -N the bar row carries its own trailing cells, so it paints green
    // even though the parser's stale background is red (F2).
    expect(term.bgs(4)).toEqual(allBg(GREEN));
  });

  it("rows scrolled in after a colored frame are not plated with it", () => {
    const term = new ToyTerminal(COLS, ROWS);
    const prev = [pad("one"), pad("two"), pad("three"), pad("four"), bar(RED)];
    term.write(fullRepaint([], prev)); // parser bg is red
    const next = [...prev.slice(1), pad("new line")];
    term.write(frameUpdate(prev, next));
    // The red bar scrolled up intact...
    expect(term.bgs(3)).toEqual(allBg(RED));
    // ...and the plain new row is default (F3: it used to take the red fill).
    expect(term.text(4)).toBe("new line");
    expect(term.bgs(4)).toEqual(allBg(null));
  });

  it("a screen repaint after a colored frame does not plate the cleared screen", () => {
    const term = new ToyTerminal(COLS, ROWS);
    term.write(fullRepaint([], [pad(""), pad(""), pad(""), pad(""), bar(RED)]));
    term.write(screenRepaint([chip("echo"), pad("mid"), pad(""), pad(""), bar(GREEN)]));
    expect(term.bgs(0)).toEqual([...Array(6).fill(GREEN), ...Array(6).fill(null)]);
    expect(term.bgs(1)).toEqual(allBg(null));
    expect(term.bgs(2)).toEqual(allBg(null));
    expect(term.bgs(3)).toEqual(allBg(null));
    expect(term.bgs(4)).toEqual(allBg(GREEN));
  });
});
