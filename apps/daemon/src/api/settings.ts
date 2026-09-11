/**
 * Daemon-wide settings (`<stateDir>/settings.json`, all projects): default
 * worker concurrency applied to new projects, the worker-pipeline toggles
 * that gate the PR loop's always-on behaviors (issue #106, default ON), and
 * the merged-PR browser-notification toggle (issue #111, default OFF).
 */

import { z } from "zod";
import { settingsSchema, type Settings } from "@pideck/shared";

import { JsonStore } from "../json-store.js";

const persistedSchema = settingsSchema.extend({ version: z.literal(1) });

// Issue #424 (F2): the review-account pair is both-or-neither — a token
// without its login (or vice versa) would configure half a second identity
// and strand the review flow between modes. Enforced on the MERGED settings
// (a patch carrying one half while the other is already stored is legal);
// the load path stays tolerant so a pre-validation asymmetric file degrades
// to an inert review cycle instead of resetting every setting.
const updateSchema = settingsSchema.superRefine((settings, ctx) => {
  if ((settings.reviewAccountToken === null) !== (settings.reviewAccountUsername === null)) {
    ctx.addIssue({
      code: "custom",
      path: ["reviewAccountToken"],
      message: "reviewAccountToken and reviewAccountUsername must be set together — both, or neither",
    });
  }
});

const DEFAULT_SETTINGS: Settings = {
  // Issue #280: new projects default to a 3-worker concurrency cap (was 1).
  defaultWorkerConcurrency: 3,
  terminateOnMerge: true,
  autoFixCi: true,
  autoFixReviewComments: true,
  autoReview: true,
  // Issue #471: reuse a done same-lane worker for follow-on work while its
  // context occupancy stays at/below 20% of the model's context window;
  // above it the follow-on spawns fresh.
  workerReuseContextThreshold: 20,
  browserMergeNotifications: false,
  // Issue #407: null (default) = single-account mode — the review flow is
  // entirely off. Username + token configure the second GitHub identity the
  // reviewer panes run as (GH_TOKEN) and the review-user-keyed legs.
  reviewAccountUsername: null,
  reviewAccountToken: null,
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
    // Issue #424 (F2): the both-or-neither refine rides the merged result —
    // a ZodError here is a 400 via the router's dispatch error path.
    const next = updateSchema.parse({ ...this.current, ...patch });
    this.current = next;
    this.file.save({ ...next, version: 1 });
    return next;
  }
}
