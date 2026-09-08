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

export const DEFAULT_SETTINGS: Settings = {
  autoAgentUsername: null,
  defaultWorkerConcurrency: 1,
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
    // Settings written before #106 lack the pipeline toggles; the schema
    // defaults fill them in (all ON) so an old file upgrades on load. The
    // #111 browser-notification toggle fills in OFF the same way.
    this.current = {
      autoAgentUsername: loaded.autoAgentUsername,
      defaultWorkerConcurrency: loaded.defaultWorkerConcurrency,
      terminateOnMerge: loaded.terminateOnMerge,
      autoFixCi: loaded.autoFixCi,
      autoFixReviewComments: loaded.autoFixReviewComments,
      autoReview: loaded.autoReview,
      browserMergeNotifications: loaded.browserMergeNotifications,
    };
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
