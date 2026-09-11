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

  it("ships the workflow skills plus the every-persona CLI catalog, uniquely named (issue #463)", () => {
    expect(SHIPPED_DEFAULT_SKILLS.map((s) => s.name)).toEqual([
      "using-pideck",
      "bash-triage",
      "concept-brief",
      "prd",
      "spec-to-issues",
    ]);
  });

  it("defaults the workflow skills to the orchestrator; the CLI catalog ships to every persona (issue #463)", () => {
    for (const entry of SHIPPED_DEFAULT_SKILLS) {
      expect(entry.defaultPersonas).toEqual(entry.name === "using-pideck" ? [...PERSONAS] : ["orchestrator"]);
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
