/**
 * Project-settings contract (issues #168, #322): the per-project automation
 * settings schema — tri-state pipeline-toggle overrides on top of the
 * auto-agent username and worker-concurrency cap. Split from index.test.ts
 * (kiss max-lines budget).
 */

import { describe, expect, it } from "vitest";

import { laneSlugSchema, projectSettingsSchema } from "./index.js";

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

  it("accepts a per-project reuse-threshold override (issue #471)", () => {
    const settings = projectSettingsSchema.parse({ workerReuseContextThreshold: 50 });
    expect(settings.workerReuseContextThreshold).toBe(50);
    // `null` = explicit clear → inherit the daemon-wide threshold.
    expect(projectSettingsSchema.parse({ workerReuseContextThreshold: null }).workerReuseContextThreshold).toBeNull();
    // Bounds: integer percent, 1..100.
    expect(projectSettingsSchema.safeParse({ workerReuseContextThreshold: 0 }).success).toBe(false);
    expect(projectSettingsSchema.safeParse({ workerReuseContextThreshold: 101 }).success).toBe(false);
    expect(projectSettingsSchema.safeParse({ workerReuseContextThreshold: 1.5 }).success).toBe(false);
  });

  it("validates the lane slug (issue #471)", () => {
    expect(laneSlugSchema.parse("backend")).toBe("backend");
    expect(laneSlugSchema.parse("feature-2")).toBe("feature-2");
    expect(laneSlugSchema.safeParse("Bad Lane").success).toBe(false);
    expect(laneSlugSchema.safeParse("-lead").success).toBe(false);
    expect(laneSlugSchema.safeParse("trail-").success).toBe(false);
    expect(laneSlugSchema.safeParse("x".repeat(65)).success).toBe(false);
    expect(laneSlugSchema.safeParse("").success).toBe(false);
  });
});
