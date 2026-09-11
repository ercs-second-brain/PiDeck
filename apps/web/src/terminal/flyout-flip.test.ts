/**
 * Unit tests for the generic screen-edge flyout flip (issue #448, B8): the
 * placement chooser mirrors any axis whose default placement (left of the
 * anchor, top-aligned) would overflow a screen edge — left→right,
 * top-aligned→bottom-aligned — preferring the default and then the first
 * candidate that fits the viewport entirely.
 */

import { describe, expect, it } from "vitest";

import { bestFlyoutPlacement, type FlyoutBox } from "./flyout-flip";

const VIEWPORT = { width: 1024, height: 768 };

/** A flyout small enough to fit on either side of an anchor. */
const small = { width: 120, height: 160 };

describe("bestFlyoutPlacement (issue #448, B8)", () => {
  it("keeps the default left/top placement when it fits", () => {
    const anchor: FlyoutBox = { left: 300, top: 100, right: 316, bottom: 128 };
    expect(bestFlyoutPlacement(anchor, small, VIEWPORT)).toEqual({ side: "left", align: "top" });
  });

  it("flips to the anchor's right side when the left placement overflows the left edge", () => {
    // Anchor at the screen's left edge: a left-opening 120px flyout overflows.
    const anchor: FlyoutBox = { left: 20, top: 100, right: 36, bottom: 128 };
    expect(bestFlyoutPlacement(anchor, small, VIEWPORT)).toEqual({ side: "right", align: "top" });
  });

  it("extends upward when the top-aligned placement overflows the bottom edge", () => {
    // Anchor near the screen bottom: the downward flyout (200px) overflows
    // the 768px viewport; the upward mirror (bottom at the anchor's bottom
    // 730 → top 530) fits.
    const anchor: FlyoutBox = { left: 300, top: 700, right: 316, bottom: 730 };
    expect(bestFlyoutPlacement(anchor, { width: 120, height: 200 }, VIEWPORT)).toEqual({ side: "left", align: "bottom" });
  });

  it("flips both axes when left/top overflows the left and the bottom edge", () => {
    const anchor: FlyoutBox = { left: 20, top: 720, right: 36, bottom: 750 };
    expect(bestFlyoutPlacement(anchor, small, VIEWPORT)).toEqual({ side: "right", align: "bottom" });
  });

  it("keeps the default when nothing fits (viewport smaller than the flyout)", () => {
    const anchor: FlyoutBox = { left: 8, top: 8, right: 24, bottom: 38 };
    expect(bestFlyoutPlacement(anchor, { width: 2000, height: 1000 }, VIEWPORT)).toEqual({ side: "left", align: "top" });
  });

  it("falls through to a fitting candidate when a flipped axis would overflow the opposite edge", () => {
    // Anchor hard against the left edge with a flyout wider than the space
    // to its left AND taller than fits downward: right/top overflows the
    // bottom, left/bottom overflows the left → right/bottom wins.
    const anchor: FlyoutBox = { left: 0, top: 700, right: 16, bottom: 730 };
    expect(bestFlyoutPlacement(anchor, { width: 900, height: 200 }, VIEWPORT)).toEqual({ side: "right", align: "bottom" });
  });
});