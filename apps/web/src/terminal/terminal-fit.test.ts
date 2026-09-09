/**
 * Unit tests for the terminal fit/resize controller (issues #124 and #353):
 * the wiring that turns xterm fit measurements into `terminal.resize` frames.
 * Pure node — the xterm connection and fit calls are fakes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFitController } from "./terminal-fit";

function makeHarness(initial: { cols: number; rows: number } = { cols: 80, rows: 24 }) {
  const terminal = { ...initial };
  const resize = vi.fn();
  const connection = { resize };
  const onFitted = vi.fn();
  const fit = vi.fn(() => {
    // Stand-in for the fit addon: the suite mutates `pending` to simulate
    // the container changing under the observer.
    terminal.cols = harness.pending.cols;
    terminal.rows = harness.pending.rows;
  });
  const harness = {
    terminal,
    resize,
    onFitted,
    fit,
    pending: { ...initial },
    fitNow: (() => {}) as () => void,
    dispose: () => {},
  };
  const controller = createFitController({ terminal, fit, connection, onFitted });
  harness.fitNow = controller;
  harness.dispose = controller.dispose;
  return harness;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createFitController (issue #124)", () => {
  it("sends a resize frame when the fitted size changes", () => {
    const h = makeHarness();
    h.pending = { cols: 154, rows: 51 };
    h.fitNow();
    expect(h.fit).toHaveBeenCalledOnce();
    expect(h.resize).toHaveBeenCalledWith(154, 51);
    expect(h.onFitted).toHaveBeenCalledWith({ cols: 154, rows: 51 });
  });

  it("does not send a duplicate frame when the size is unchanged", () => {
    const h = makeHarness();
    h.pending = { cols: 154, rows: 51 };
    h.fitNow();
    h.fitNow();
    h.fitNow();
    vi.advanceTimersByTime(200);
    expect(h.resize).toHaveBeenCalledTimes(1);
  });

  it("sends again when the viewport changes the fitted size", () => {
    const h = makeHarness({ cols: 154, rows: 51 });
    h.pending = { cols: 100, rows: 40 };
    h.fitNow();
    expect(h.resize).toHaveBeenLastCalledWith(100, 40);
    h.pending = { cols: 100, rows: 45 };
    h.fitNow();
    vi.advanceTimersByTime(200);
    expect(h.resize).toHaveBeenLastCalledWith(100, 45);
  });

  it("swallows a failed fit but still reports and propagates the current size", () => {
    // Container not measurable yet (e.g. hidden during a route transition):
    // the exception must not break the observer callback chain.
    const terminal = { cols: 80, rows: 24 };
    const resize = vi.fn();
    const onFitted = vi.fn();
    const fitNow = createFitController({
      terminal,
      fit: () => {
        throw new Error("cannot measure");
      },
      connection: { resize },
      onFitted,
    });
    expect(() => fitNow()).not.toThrow();
    expect(onFitted).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    expect(resize).not.toHaveBeenCalled(); // unchanged size → no frame
  });
});

describe("createFitController resize coalescing (issue #353)", () => {
  it("fits synchronously on the first call (the pane attaches with that size)", () => {
    const h = makeHarness();
    h.pending = { cols: 120, rows: 40 };
    h.fitNow();
    // No timer advance: the leading fit must already have happened.
    expect(h.fit).toHaveBeenCalledOnce();
    expect(h.resize).toHaveBeenCalledWith(120, 40);
  });

  it("coalesces a resize burst into one trailing fit", () => {
    const h = makeHarness({ cols: 120, rows: 40 });
    // Simulate a drag: the container changes on every observer event.
    for (let cols = 121; cols <= 130; cols++) {
      h.pending = { cols, rows: 40 };
      h.fitNow();
    }
    // Nothing landed yet — the burst is still being coalesced.
    expect(h.fit).toHaveBeenCalledTimes(1); // leading fit only
    expect(h.resize).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(150);
    expect(h.fit).toHaveBeenCalledTimes(2);
    expect(h.resize).toHaveBeenLastCalledWith(130, 40);
    expect(h.onFitted).toHaveBeenLastCalledWith({ cols: 130, rows: 40 });
  });

  it("does not fit while the container keeps changing", () => {
    const h = makeHarness();
    h.fitNow(); // leading
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(100); // events keep arriving inside the window
      h.pending = { cols: 100 + i, rows: 40 };
      h.fitNow();
    }
    expect(h.fit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(150);
    expect(h.fit).toHaveBeenCalledTimes(2);
    expect(h.resize).toHaveBeenLastCalledWith(109, 40);
  });

  it("dispose cancels a pending trailing fit", () => {
    const h = makeHarness();
    h.pending = { cols: 120, rows: 40 };
    h.fitNow(); // leading — also sends the first resize frame
    h.pending = { cols: 90, rows: 30 };
    h.fitNow(); // scheduled trailing fit
    h.dispose();
    vi.advanceTimersByTime(500);
    expect(h.fit).toHaveBeenCalledTimes(1);
    expect(h.resize).toHaveBeenCalledTimes(1);
  });

  it("debounceMs 0 disables the coalescing (immediate every call)", () => {
    const terminal = { cols: 80, rows: 24 };
    const resize = vi.fn();
    const fit = vi.fn(() => {
      terminal.cols = 100;
      terminal.rows = 40;
    });
    const fitNow = createFitController({
      terminal,
      fit,
      connection: { resize },
      debounceMs: 0,
    });
    fitNow();
    fitNow();
    expect(fit).toHaveBeenCalledTimes(2);
    expect(resize).toHaveBeenLastCalledWith(100, 40);
  });
});
