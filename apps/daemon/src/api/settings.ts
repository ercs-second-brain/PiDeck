/**
 * Daemon-wide settings (`<stateDir>/settings.json`): default auto-agent
 * username and default worker concurrency applied to new projects.
 */

import { z } from "zod";
import { settingsSchema, type Settings } from "@agentskiss/shared";

import { JsonStore } from "../json-store.js";

const persistedSchema = settingsSchema.extend({ version: z.literal(1) });

export const DEFAULT_SETTINGS: Settings = {
  autoAgentUsername: null,
  defaultWorkerConcurrency: 1,
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
    this.current = { autoAgentUsername: loaded.autoAgentUsername, defaultWorkerConcurrency: loaded.defaultWorkerConcurrency };
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
