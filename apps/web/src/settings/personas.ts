/** Model-picker copy for the settings screens, keyed by persona. */

import type { Persona } from "@pideck/shared";

export const PERSONA_MODEL_DESCRIPTIONS: Record<Persona, string> = {
  global: "Model for the global agent.",
  orchestrator: "Model for project orchestrators.",
  worker: "Model for workers.",
  reviewer: "Model for reviewers.",
};