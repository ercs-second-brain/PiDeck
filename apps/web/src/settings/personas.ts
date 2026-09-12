/** Display names for the four hardcoded personas, shared by the settings screens. */

import type { Persona } from "@pideck/shared";

export const PERSONA_LABELS: Record<Persona, string> = {
  global: "Global",
  orchestrator: "Orchestrator",
  worker: "Worker",
  reviewer: "Reviewer",
};

export const PERSONA_MODEL_DESCRIPTIONS: Record<Persona, string> = {
  global: "Model for the global agent.",
  orchestrator: "Model for project orchestrators.",
  worker: "Model for workers.",
  reviewer: "Model for reviewers.",
};