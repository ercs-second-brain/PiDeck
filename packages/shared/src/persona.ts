import { z } from "zod";

export const PersonaSchema = z.enum(["global", "orchestrator", "worker", "reviewer"]);

export type Persona = z.infer<typeof PersonaSchema>;

export const Personas: readonly Persona[] = PersonaSchema.options;
