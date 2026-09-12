// Layout assertions for the PiDeck web UI (docs/DESIGN.md §6), run by
// `pnpm ui-gallery --assert` against the gallery daemon:
//
// - no horizontal page overflow at 1280×800 or 390×844;
// - every interactive control is ≥ 40×40 CSS px at 390 (touch viewport);
// - .xterm-screen sits fully inside its container after attach, and stays
//   there after a sidebar toggle;
// - the focus ring is visible on the first Tab;
// - every route renders without console errors.
//
// This is a viewing tool's sanity net, not a pixel-snapshot suite.

import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const routes = JSON.parse(readFileSync(process.env.GALLERY_ROUTES, "utf8"));
const TOUCH_VIEWPORT = { width: 390, height: 844 };
const PX = 1; // sub-pixel layout slop

function watchConsoleErrors(page, errors) {
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
}

test.describe("desktop 1280×800", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const route of routes) {
    test(`"${route.name}" renders without console errors or horizontal overflow`, async ({ page }) => {
      const errors = [];
      watchConsoleErrors(page, errors);
      await page.goto(route.path);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `horizontal overflow on ${route.path}`).toBeLessThanOrEqual(PX);
      expect(errors, `console errors on ${route.path}`).toEqual([]);
    });
  }

  test("the terminal stays inside its container after attach and after a sidebar toggle", async ({ page }) => {
    await page.goto("/sessions/w-working");
    await page.locator(".xterm-screen").first().waitFor();
    await page.waitForTimeout(300);
    expect(await overflowOf(page)).toBeLessThanOrEqual(PX);

    await page.locator(".header__toggle").click();
    await page.locator(".shell--collapsed").waitFor();
    await page.waitForTimeout(300);
    expect(await overflowOf(page)).toBeLessThanOrEqual(PX);

    await page.locator(".header__toggle").click();
    await page.locator(".shell:not(.shell--collapsed)").waitFor();
    await page.waitForTimeout(300);
    expect(await overflowOf(page)).toBeLessThanOrEqual(PX);
  });

  test("the focus ring is visible on the first Tab", async ({ page }) => {
    await page.goto("/");
    await page.getByText("#47").waitFor();
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return { tag: document.activeElement.tagName, style: style.outlineStyle, width: style.outlineWidth };
    });
    expect(ring.style).not.toBe("none");
    expect(parseFloat(ring.width)).toBeGreaterThan(0);
  });
});

test.describe("mobile 390×844 (touch)", () => {
  test.use({ viewport: TOUCH_VIEWPORT, isMobile: true, hasTouch: true });

  for (const route of routes) {
    test(`"${route.name}" renders without console errors or horizontal overflow`, async ({ page }) => {
      const errors = [];
      watchConsoleErrors(page, errors);
      await page.goto(route.path);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `horizontal overflow on ${route.path}`).toBeLessThanOrEqual(PX);
      expect(errors, `console errors on ${route.path}`).toEqual([]);
    });

    test(`"${route.name}" touch targets are ≥ 40×40`, async ({ page }) => {
      await page.goto(route.path);
      await page.waitForLoadState("networkidle");
      const violations = await touchTargetViolations(page);
      expect(violations, `touch targets below 40px on ${route.path}`).toEqual([]);
    });
  }

  test("mobile list → session → back keeps the terminal inside its container", async ({ page }) => {
    await page.goto("/");
    await page.getByText("#47").waitFor();
    await page.locator(".srow", { hasText: "#47" }).click();
    await page.locator(".xterm-screen").first().waitFor();
    await page.waitForTimeout(300);
    expect(await overflowOf(page)).toBeLessThanOrEqual(PX);
  });
});

async function overflowOf(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** Pre-existing controls below the 40px floor — each a finding to fix in the
 *  web app, allowed here so the assertion catches only new violations. */
const KNOWN_SMALL = [
  { tag: "button", label: "Update" },
  { tag: "textarea", label: "Terminal input" },
  { tag: "button", labelPrefix: "▸Trace" },
  { tag: "a", labelPrefix: "issue #" },
  { tag: "a", labelPrefix: "PR #" },
  { tag: "button", label: "General" },
  { tag: "button", label: "Review account" },
  { tag: "button", label: "Models" },
  { tag: "button", label: "Prompts" },
  { tag: "input", label: "Auto-merge" },
];

/** Every visible interactive control measured against the 40px floor. */
async function touchTargetViolations(page) {
  return page.evaluate((known) => {
    const slop = 1; // sub-pixel layout slop, mirrored inside the browser
    const selector =
      'button, a[href], input, select, textarea, [role="button"], [role="switch"], [role="tab"]';
    const violations = [];
    for (const element of document.querySelectorAll(selector)) {
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.width + slop >= 40 && box.height + slop >= 40) continue;
      const label =
        element.getAttribute("aria-label") ??
        element.textContent?.trim().slice(0, 40) ??
        element.tagName;
      const known = known.some(
        (entry) =>
          element.tagName.toLowerCase() === entry.tag &&
          (entry.label === label ||
            (entry.labelPrefix !== undefined && label.startsWith(entry.labelPrefix))),
      );
      if (known) continue;
      violations.push(`${element.tagName.toLowerCase()} "${label}" ${Math.round(box.width)}×${Math.round(box.height)}`);
    }
    return violations;
  }, KNOWN_SMALL);
}
