/**
 * Generic screen-edge flip for flyout submenus (issue #448, B8): a flyout
 * anchored to its parent item (the sidebar ⋯ menu's spawn-agent submenu,
 * issue #355) is placed at its default position — LEFT of the anchor,
 * top-aligned with it — and the placement chooser below mirrors any axis
 * whose default placement would overflow a screen edge: left→right, and
 * top-aligned→bottom-aligned (extends upward). Pure geometry, no DOM.
 */

/** The anchor/flyout box the placement math works on (viewport coordinates). */
export interface FlyoutBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FlyoutPlacement {
  side: "left" | "right";
  align: "top" | "bottom";
}

/** Gap between the anchor and the flyout (matches the CSS `calc(100% + 4px)`). */
const GAP = 4;

/** The four candidate placements, in preference order (default first). */
const CANDIDATES: readonly FlyoutPlacement[] = [
  { side: "left", align: "top" },
  { side: "right", align: "top" },
  { side: "left", align: "bottom" },
  { side: "right", align: "bottom" },
];

/** The viewport-space rect of one candidate placement. */
function placedRect(anchor: FlyoutBox, size: { width: number; height: number }, placement: FlyoutPlacement): FlyoutBox {
  const left = placement.side === "left" ? anchor.left - GAP - size.width : anchor.right + GAP;
  const top = placement.align === "top" ? anchor.top : anchor.bottom - size.height;
  return { left, top, right: left + size.width, bottom: top + size.height };
}

function fits(rect: FlyoutBox, viewport: { width: number; height: number }): boolean {
  return rect.left >= 0 && rect.top >= 0 && rect.right <= viewport.width && rect.bottom <= viewport.height;
}

/**
 * Picks the anchor-relative placement for a flyout of `size` whose default
 * (left-of-anchor, top-aligned) placement would overflow a screen edge
 * (issue #448, B8): the first candidate that fits the viewport entirely
 * wins; if none fits (viewport smaller than the flyout on both axes), the
 * default placement is kept — the browser then clips it as before.
 */
export function bestFlyoutPlacement(
  anchor: FlyoutBox,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): FlyoutPlacement {
  for (const candidate of CANDIDATES) {
    if (fits(placedRect(anchor, size, candidate), viewport)) return candidate;
  }
  return CANDIDATES[0]!;
}