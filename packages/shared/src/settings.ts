import { z } from "zod";
import { PersonaSchema } from "./persona.js";

export const ReviewAccountSchema = z.object({
  username: z.string().min(1),
  token: z.string().min(1),
});

export type ReviewAccount = z.infer<typeof ReviewAccountSchema>;

export const GlobalSettingsSchema = z.object({
  reviewAccount: ReviewAccountSchema,
  modelByPersona: z
    .record(PersonaSchema, z.string().nullable())
    .default({ global: null, orchestrator: null, worker: null, reviewer: null }),
});

export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>;

export function maskToken(token: string): string {
  return token ? `••••${token.slice(-4)}` : "";
}
