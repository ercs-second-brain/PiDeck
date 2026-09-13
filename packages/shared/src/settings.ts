import { z } from "zod";
import { PersonaSchema } from "./persona.js";

export const ReviewAccountSchema = z.object({
  username: z.string().min(1),
  token: z.string().min(1),
});

export type ReviewAccount = z.infer<typeof ReviewAccountSchema>;

/**
 * The workflow requires a second GitHub account that reviews every PR. A
 * settings file without one is onboarding incomplete, not a valid config:
 * the store models the pre-onboarding state as `null` on disk, and every
 * consumer that needs credentials goes through `reviewToken()`, which throws
 * this error. The PUT contract can replace the account but never clear it.
 */
export class NotOnboarded extends Error {
  constructor() {
    super("not onboarded: the review account is required — finish onboarding first");
    this.name = "NotOnboarded";
  }
}

export const GlobalSettingsSchema = z.object({
  // Nullable only to represent the pre-onboarding file; see NotOnboarded.
  reviewAccount: ReviewAccountSchema.nullable().default(null),
  modelByPersona: z
    .record(PersonaSchema, z.string().nullable())
    .default({ global: null, orchestrator: null, worker: null, reviewer: null }),
});

export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>;

export const GlobalSettingsReadSchema = z.object({
  reviewAccount: z
    .object({
      username: z.string(),
      tokenSet: z.boolean(),
    })
    .nullable(),
  modelByPersona: z.record(PersonaSchema, z.string().nullable()),
});

export type GlobalSettingsRead = z.infer<typeof GlobalSettingsReadSchema>;

export const ReviewAccountPutSchema = z.object({
  username: z.string().min(1),
  token: z.string().min(1).optional(),
});

export type ReviewAccountPut = z.infer<typeof ReviewAccountPutSchema>;

export const GlobalSettingsPutSchema = z.object({
  // The account can be replaced but never cleared: null is rejected up front
  // so an accidental clear cannot take the daemon's review leg offline.
  reviewAccount: ReviewAccountPutSchema
    .nullable()
    .optional()
    .refine((account) => account !== null, {
      error: "the review account is required — it can be replaced but not cleared",
    }),
  modelByPersona: z.record(PersonaSchema, z.string().nullable()).optional(),
});

export type GlobalSettingsPut = z.infer<typeof GlobalSettingsPutSchema>;
