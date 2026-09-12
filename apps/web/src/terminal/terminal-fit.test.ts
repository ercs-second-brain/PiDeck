/**
 * Unit tests for the terminal fit/resize controller: the wiring that turns
 * xterm fit measurements into `terminal.resize` frames. Pure node — the fit
 * addon and connection are fakes.
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

describe("createFitController", () => {
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
    expect(h.resize).toHaveBeenCalledOnce();
  });

  it("coalesces a burst of container changes into one trailing fit", () => {
    const h = makeHarness();
    for (const size of [
      { cols: 100, rows: 30 },
      { cols: 120, rows: 35 },
      { cols: 140, rows: 40 },
    ]) {
      h.pending = size;
      h.fitNow();
    }
    expect(h.fit).toHaveBeenCalledOnce(); // the initial synchronous fit
    vi.advanceTimersByTime(150);
    expect(h.fit).toHaveBeenCalledTimes(2);
    expect(h.resize).toHaveBeenCalledWith(140, 40);
  });

  it("the first invocation fits synchronously so the pane attaches with real dimensions", () => {
    const h = makeHarness();
    h.fitNow();
    expect(h.fit).toHaveBeenCalledOnce();
    expect(h.onFitted).toHaveBeenCalledWith({ cols: 80, rows: 24 });
  });

  it("swallows a failed fit and still reports the current size", () => {
    const terminal = { cols: 80, rows: 24 };
    const resize = vi.fn();
    const onFitted = vi.fn();
    const controller = createFitController({
      terminal,
      fit: () => {
        throw new Error("unmeasurable");
      },
      connection: { resize },
      onFitted,
    });
    controller();
    expect(resize).not.toHaveBeenCalled();
    expect(onFitted).toHaveBeenCalledWith({ cols: 80, rows: 24 });
  });

  it("dispose cancels a pending trailing fit", () => {
    const h = makeHarness();
    h.pending = { cols: 120, rows: 35 };
    h.fitNow();
    h.dispose();
    vi.advanceTimersByTime(300);
    expect(h.fit).toHaveBeenCalledOnce();
  });
});