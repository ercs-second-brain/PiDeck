// Playwright config for the gallery's layout assertions, run by
// `pnpm ui-gallery --assert` against the already-running gallery daemon.

const baseURL = process.env.GALLERY_BASE_URL ?? "http://127.0.0.1:8321";

/** @type {import('@playwright/test').Config} */
export default {
  testDir: import.meta.dirname,
  testMatch: "assert.spec.mjs",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    baseURL,
    headless: true,
    screenshot: "off",
    trace: "off",
  },
};
