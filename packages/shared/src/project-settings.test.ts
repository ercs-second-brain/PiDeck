/**
 * Project-settings contract (issues #168, #322): the per-project automation
 * settings schema — tri-state pipeline-toggle overrides on top of the
 * auto-agent username and worker-concurrency cap. Split from index.test.ts
 * (kiss max-lines budget).
 */

import { describe, expect, it } from "vitest";

import { projectSettingsSchema } from "./index.js";

describe("domain: project settings", () => {
  it("accepts per-project pipeline toggle overrides (issue #322)", () => {
    const settings = projectSettingsSchema.parse({
      autoReview: false,
      autoFixCi: true,
      terminateOnMerge: null, // explicit clear → inherit the daemon-wide toggle
    });
    expect(settings.autoReview).toBe(false);
    expect(settings.autoFixCi).toBe(true);
    expect(settings.terminateOnMerge).toBeNull();
    expect(settings.autoFixReviewComments).toBeUndefined();
  });
});
