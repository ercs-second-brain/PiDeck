import { z } from "zod";
import { PersonaSchema } from "./persona.js";

export const ReviewAccountSchema = z.object({
  username: z.string().min(1),
  token: z.string().min(1),
});

export type ReviewAccount = z.infer<typeof ReviewAccountSchema>;

export const GlobalSettingsSchema = z.object({
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
  reviewAccount: ReviewAccountPutSchema.nullable().optional(),
  modelByPersona: z.record(PersonaSchema, z.string().nullable()).optional(),
});

export type GlobalSettingsPut = z.infer<typeof GlobalSettingsPutSchema>;
