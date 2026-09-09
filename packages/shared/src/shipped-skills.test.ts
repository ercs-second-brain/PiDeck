import { describe, expect, it } from "vitest";

import {
  agentSkillIdSchema,
  PERSONAS,
  personaSchema,
  SHIPPED_DEFAULT_SKILLS,
  shippedDefaultSkillSchema,
} from "./index.js";

describe("SHIPPED_DEFAULT_SKILLS (issue #338 — shipped-default seed data for #315's agent-assets surface)", () => {
  it("parses every entry against the shipped-default skill schema", () => {
    for (const entry of SHIPPED_DEFAULT_SKILLS) {
      expect(shippedDefaultSkillSchema.parse(entry)).toEqual(entry);
    }
  });

  it("ships exactly the four orchestrator workflow skills, uniquely named", () => {
    expect(SHIPPED_DEFAULT_SKILLS.map((s) => s.name)).toEqual([
      "bash-triage",
      "concept-brief",
      "prd",
      "spec-to-issues",
    ]);
  });

  it("defaults every entry to the orchestrator persona only", () => {
    for (const entry of SHIPPED_DEFAULT_SKILLS) {
      expect(entry.defaultPersonas).toEqual(["orchestrator"]);
    }
  });

  it("stays inside the canonical PERSONAS vocabulary and the skill-id contract", () => {
    expect(personaSchema.options).toEqual(PERSONAS);
    for (const entry of SHIPPED_DEFAULT_SKILLS) {
      expect(agentSkillIdSchema.safeParse(entry.name).success).toBe(true);
      for (const persona of entry.defaultPersonas) {
        expect(PERSONAS).toContain(persona);
      }
    }
  });
});
