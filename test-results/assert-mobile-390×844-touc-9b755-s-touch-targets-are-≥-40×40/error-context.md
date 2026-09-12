# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: assert.spec.mjs >> mobile 390×844 (touch) >> "project settings" touch targets are ≥ 40×40
- Location: tools/ui-gallery/assert.spec.mjs:90:5

# Error details

```
Error: touch targets below 40px on /projects/my-api/settings

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 4

- Array []
+ Array [
+   "button \"Update\" 62×26",
+   "input \"Auto-merge\" 36×20",
+ ]
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - banner [ref=e4]:
    - generic:
      - button "Back to sessions" [ref=e5] [cursor=pointer]: ←
      - generic: my-api › Settings
    - generic [ref=e6]:
      - generic [ref=e7]:
        - button "Update" [disabled] [ref=e8]
        - generic "agents are live — the update waits until they finish" [ref=e9]
      - button "Add project" [ref=e10] [cursor=pointer]: +
      - button "Settings" [ref=e11] [cursor=pointer]: ⚙
  - main [ref=e13]:
    - generic [ref=e14]:
      - heading "my-api settings" [level=1] [ref=e15]
      - generic [ref=e16]:
        - generic [ref=e17]:
          - heading "Settings" [level=2] [ref=e18]
          - paragraph [ref=e19]: Knobs for this project's loop. They apply from the next reconciliation.
          - generic [ref=e20]:
            - generic [ref=e21]:
              - generic [ref=e22]:
                - generic [ref=e23]: Worker concurrency
                - generic [ref=e24]: Maximum workers running at once for this project.
              - spinbutton "Worker concurrency" [ref=e27]: "3"
            - generic [ref=e28]:
              - generic [ref=e29]:
                - generic [ref=e30]: Max fix attempts
                - generic [ref=e31]: CI/review fix rounds before the worker reports back and goes idle.
              - spinbutton "Max fix attempts" [ref=e34]: "5"
            - generic [ref=e35]:
              - generic [ref=e36]:
                - generic [ref=e37]: Context limit
                - generic [ref=e38]: Percent of context usage that replaces a session.
              - spinbutton "Context limit percent" [ref=e41]: "80"
            - generic [ref=e42]:
              - generic [ref=e43]:
                - generic [ref=e44]: Stall minutes
                - generic [ref=e45]: Silence for this long steers the orchestrator to check on the worker.
              - spinbutton "Stall minutes" [ref=e48]: "20"
            - generic [ref=e49]:
              - generic [ref=e50]:
                - generic [ref=e51]: Auto-merge
                - generic [ref=e52]: Merge approved, green PRs automatically; otherwise recommend the merge.
              - switch "Auto-merge" [ref=e55] [cursor=pointer]
          - button "Save" [ref=e57] [cursor=pointer]
        - generic [ref=e58]:
          - heading "Danger" [level=2] [ref=e59]
          - paragraph [ref=e60]: Deleting my-api removes its settings and sessions. GitHub issues and PRs are untouched.
          - generic [ref=e62]:
            - generic [ref=e63]:
              - generic [ref=e64]: Repo
              - generic [ref=e65]: Unaffected on GitHub.
            - generic [ref=e66]: acme/my-api
          - button "Delete project" [ref=e68] [cursor=pointer]
```

# Test source

```ts
  1   | // Layout assertions for the PiDeck web UI (docs/DESIGN.md §6), run by
  2   | // `pnpm ui-gallery --assert` against the gallery daemon:
  3   | //
  4   | // - no horizontal page overflow at 1280×800 or 390×844;
  5   | // - every interactive control is ≥ 40×40 CSS px at 390 (touch viewport);
  6   | // - .xterm-screen sits fully inside its container after attach, and stays
  7   | //   there after a sidebar toggle;
  8   | // - the focus ring is visible on the first Tab;
  9   | // - every route renders without console errors.
  10  | //
  11  | // This is a viewing tool's sanity net, not a pixel-snapshot suite.
  12  | 
  13  | import { readFileSync } from "node:fs";
  14  | import { expect, test } from "@playwright/test";
  15  | 
  16  | const routes = JSON.parse(readFileSync(process.env.GALLERY_ROUTES, "utf8"));
  17  | const TOUCH_VIEWPORT = { width: 390, height: 844 };
  18  | const PX = 1; // sub-pixel layout slop
  19  | 
  20  | function watchConsoleErrors(page, errors) {
  21  |   page.on("console", (message) => {
  22  |     if (message.type() === "error") errors.push(message.text());
  23  |   });
  24  |   page.on("pageerror", (error) => errors.push(String(error)));
  25  | }
  26  | 
  27  | test.describe("desktop 1280×800", () => {
  28  |   test.use({ viewport: { width: 1280, height: 800 } });
  29  | 
  30  |   for (const route of routes) {
  31  |     test(`"${route.name}" renders without console errors or horizontal overflow`, async ({ page }) => {
  32  |       const errors = [];
  33  |       watchConsoleErrors(page, errors);
  34  |       await page.goto(route.path);
  35  |       await page.waitForLoadState("networkidle");
  36  |       const overflow = await page.evaluate(
  37  |         () => document.documentElement.scrollWidth - window.innerWidth,
  38  |       );
  39  |       expect(overflow, `horizontal overflow on ${route.path}`).toBeLessThanOrEqual(PX);
  40  |       expect(errors, `console errors on ${route.path}`).toEqual([]);
  41  |     });
  42  |   }
  43  | 
  44  |   test("the terminal stays inside its container after attach and after a sidebar toggle", async ({ page }) => {
  45  |     await page.goto("/sessions/w-working");
  46  |     await page.locator(".xterm-screen").first().waitFor();
  47  |     await page.waitForTimeout(300);
  48  |     expect(await overflowOf(page)).toBeLessThanOrEqual(PX);
  49  | 
  50  |     await page.locator(".header__toggle").click();
  51  |     await page.locator(".shell--collapsed").waitFor();
  52  |     await page.waitForTimeout(300);
  53  |     expect(await overflowOf(page)).toBeLessThanOrEqual(PX);
  54  | 
  55  |     await page.locator(".header__toggle").click();
  56  |     await page.locator(".shell:not(.shell--collapsed)").waitFor();
  57  |     await page.waitForTimeout(300);
  58  |     expect(await overflowOf(page)).toBeLessThanOrEqual(PX);
  59  |   });
  60  | 
  61  |   test("the focus ring is visible on the first Tab", async ({ page }) => {
  62  |     await page.goto("/");
  63  |     await page.getByText("#47").waitFor();
  64  |     await page.keyboard.press("Tab");
  65  |     const ring = await page.evaluate(() => {
  66  |       const style = getComputedStyle(document.activeElement);
  67  |       return { tag: document.activeElement.tagName, style: style.outlineStyle, width: style.outlineWidth };
  68  |     });
  69  |     expect(ring.style).not.toBe("none");
  70  |     expect(parseFloat(ring.width)).toBeGreaterThan(0);
  71  |   });
  72  | });
  73  | 
  74  | test.describe("mobile 390×844 (touch)", () => {
  75  |   test.use({ viewport: TOUCH_VIEWPORT, isMobile: true, hasTouch: true });
  76  | 
  77  |   for (const route of routes) {
  78  |     test(`"${route.name}" renders without console errors or horizontal overflow`, async ({ page }) => {
  79  |       const errors = [];
  80  |       watchConsoleErrors(page, errors);
  81  |       await page.goto(route.path);
  82  |       await page.waitForLoadState("networkidle");
  83  |       const overflow = await page.evaluate(
  84  |         () => document.documentElement.scrollWidth - window.innerWidth,
  85  |       );
  86  |       expect(overflow, `horizontal overflow on ${route.path}`).toBeLessThanOrEqual(PX);
  87  |       expect(errors, `console errors on ${route.path}`).toEqual([]);
  88  |     });
  89  | 
  90  |     test(`"${route.name}" touch targets are ≥ 40×40`, async ({ page }) => {
  91  |       await page.goto(route.path);
  92  |       await page.waitForLoadState("networkidle");
  93  |       const violations = await touchTargetViolations(page);
> 94  |       expect(violations, `touch targets below 40px on ${route.path}`).toEqual([]);
      |                                                                       ^ Error: touch targets below 40px on /projects/my-api/settings
  95  |     });
  96  |   }
  97  | 
  98  |   test("mobile list → session → back keeps the terminal inside its container", async ({ page }) => {
  99  |     await page.goto("/");
  100 |     await page.getByText("#47").waitFor();
  101 |     await page.locator(".srow", { hasText: "#47" }).click();
  102 |     await page.locator(".xterm-screen").first().waitFor();
  103 |     await page.waitForTimeout(300);
  104 |     expect(await overflowOf(page)).toBeLessThanOrEqual(PX);
  105 |   });
  106 | });
  107 | 
  108 | async function overflowOf(page) {
  109 |   return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  110 | }
  111 | 
  112 | /** Every visible interactive control measured against the 40px floor. */
  113 | async function touchTargetViolations(page) {
  114 |   return page.evaluate(() => {
  115 |     const slop = 1; // sub-pixel layout slop, mirrored inside the browser
  116 |     const selector =
  117 |       'button, a[href], input, select, textarea, [role="button"], [role="switch"], [role="tab"]';
  118 |     const violations = [];
  119 |     for (const element of document.querySelectorAll(selector)) {
  120 |       const style = getComputedStyle(element);
  121 |       if (style.visibility === "hidden" || style.display === "none") continue;
  122 |       const box = element.getBoundingClientRect();
  123 |       if (box.width === 0 || box.height === 0) continue;
  124 |       if (box.width + slop >= 40 && box.height + slop >= 40) continue;
  125 |       const label =
  126 |         element.getAttribute("aria-label") ??
  127 |         element.textContent?.trim().slice(0, 40) ??
  128 |         element.tagName;
  129 |       violations.push(`${element.tagName.toLowerCase()} "${label}" ${Math.round(box.width)}×${Math.round(box.height)}`);
  130 |     }
  131 |     return violations;
  132 |   });
  133 | }
  134 | 
```