/**
 * Pipeline-settings resolution (issues #106, #322): the per-project toggle
 * overrides win; unset/`null` per-project fields inherit the daemon-wide
 * setting; with neither, the all-ON defaults apply.
 */

import { describe, expect, it } from "vitest";

import type { ProjectSettings } from "@pideck/shared";

import { DEFAULT_WORKER_PIPELINE_SETTINGS, resolvePipelineSettings } from "./settings.js";

const ALL_OFF = { terminateOnMerge: false, autoFixCi: false, autoFixReviewComments: false, autoReview: false };

function projectSettings(overrides: Partial<ProjectSettings>): { settings: ProjectSettings } {
  return { settings: { ...overrides } };
}

describe("resolvePipelineSettings (issue #322)", () => {
  it("defaults all-ON when neither the project nor the daemon provides settings", () => {
    expect(resolvePipelineSettings(undefined, undefined)).toEqual(DEFAULT_WORKER_PIPELINE_SETTINGS);
  });

  it("inherits the daemon-wide settings when the project overrides nothing", () => {
    const global = { ...DEFAULT_WORKER_PIPELINE_SETTINGS, autoReview: false };
    expect(resolvePipelineSettings(projectSettings({ workerConcurrency: 3 }), global)).toEqual(global);
  });

  it("inherits per-field: `null` and unset per-project fields fall back to the daemon-wide value", () => {
    const global = { terminateOnMerge: false, autoFixCi: true, autoFixReviewComments: false, autoReview: true };
    const project = projectSettings({ autoFixCi: null, autoReview: false, terminateOnMerge: undefined });
    expect(resolvePipelineSettings(project, global)).toEqual({
      terminateOnMerge: false, // unset → daemon-wide
      autoFixCi: true, // null → daemon-wide
      autoFixReviewComments: false, // unset → daemon-wide
      autoReview: false, // explicit per-project boolean wins
    });
  });

  it("lets an explicit per-project boolean override the daemon-wide toggle", () => {
    const global = ALL_OFF;
    const project = projectSettings({ autoReview: true, autoFixCi: true });
    expect(resolvePipelineSettings(project, global)).toEqual({
      terminateOnMerge: false, // untouched → daemon-wide
      autoFixCi: true, // per-project on
      autoFixReviewComments: false, // untouched → daemon-wide
      autoReview: true, // per-project on
    });
  });

  it("ignores a missing project even when daemon-wide settings exist", () => {
    const global = ALL_OFF;
    expect(resolvePipelineSettings(undefined, global)).toEqual(global);
  });
});
