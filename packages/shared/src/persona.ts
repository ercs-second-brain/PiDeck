import { z } from "zod";

export const PersonaSchema = z.enum(["global", "orchestrator", "worker", "reviewer"]);

export type Persona = z.infer<typeof PersonaSchema>;

export const Personas: readonly Persona[] = PersonaSchema.options;

/** Display names for the four hardcoded personas. */
export const PERSONA_LABELS: Record<Persona, string> = {
  global: "Global",
  orchestrator: "Orchestrator",
  worker: "Worker",
  reviewer: "Reviewer",
};
