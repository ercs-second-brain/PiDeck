/**
 * Daemon-wide settings (`<stateDir>/settings.json`, all projects): default
 * auto-agent username, default worker concurrency applied to new projects,
 * the worker-pipeline toggles that gate the PR loop's always-on behaviors
 * (issue #106, default ON), and the merged-PR browser-notification toggle
 * (issue #111, default OFF).
 */

import { z } from "zod";
import { settingsSchema, type Settings } from "@pideck/shared";

import { JsonStore } from "../json-store.js";

const persistedSchema = settingsSchema.extend({ version: z.literal(1) });

const DEFAULT_SETTINGS: Settings = {
  autoAgentUsername: null,
  // Issue #280: new projects default to a 3-worker concurrency cap (was 1).
  defaultWorkerConcurrency: 3,
  terminateOnMerge: true,
  autoFixCi: true,
  autoFixReviewComments: true,
  autoReview: true,
  browserMergeNotifications: false,
};

export class SettingsStore {
  private readonly file: JsonStore<Settings & { version: 1 }>;
  private current: Settings;

  constructor(stateDir: string) {
    this.file = new JsonStore(`${stateDir}/settings.json`);
    const loaded = this.file.load(
      (value) => {
        const parsed = persistedSchema.safeParse(value);
        return parsed.success ? parsed.data : undefined;
      },
      { ...DEFAULT_SETTINGS, version: 1 as const },
    );
    // The parse re-applies schema defaults, so settings written before #106
    // (or before #111) upgrade on load — no per-field copy to forget when a
    // new setting is added.
    this.current = settingsSchema.parse(loaded);
  }

  get(): Settings {
    return this.current;
  }

  /** Applies a partial update; validation errors throw (→ 400 via the router). */
  update(patch: Partial<Settings>): Settings {
    const next = settingsSchema.parse({ ...this.current, ...patch });
    this.current = next;
    this.file.save({ ...next, version: 1 });
    return next;
  }
}
