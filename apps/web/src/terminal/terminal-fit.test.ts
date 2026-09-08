/**
 * Unit tests for the terminal fit/resize controller (issue #124): the
 * wiring that turns xterm fit measurements into `terminal.resize` frames.
 * Pure node — the xterm connection and fit calls are fakes.
 */

import { describe, expect, it, vi } from "vitest";
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
    fitNow: () => {},
  };
  harness.fitNow = createFitController({ terminal, fit, connection, onFitted });
  return harness;
}

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
    expect(h.resize).toHaveBeenCalledTimes(1);
  });

  it("sends again when the viewport changes the fitted size", () => {
    const h = makeHarness({ cols: 154, rows: 51 });
    h.pending = { cols: 100, rows: 40 };
    h.fitNow();
    expect(h.resize).toHaveBeenLastCalledWith(100, 40);
    h.pending = { cols: 100, rows: 45 };
    h.fitNow();
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
