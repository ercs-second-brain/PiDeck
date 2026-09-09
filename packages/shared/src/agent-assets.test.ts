/**
 * Per-persona agent-asset contract tests (issue #315): the persona
 * vocabulary, prompt-override / skill schemas, and the five agent-assets
 * endpoint shapes — split from index.test.ts (kiss max-lines budget).
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  PERSONAS,
  agentAssetsSchema,
  agentSkillIdSchema,
  endpoints,
  formatPath,
  personaSchema,
  saveAgentSkillRequestSchema,
  type AgentAssets,
  type AgentSkill,
  type EndpointRequest,
  type EndpointResponse,
  type PromptOverride,
  type SaveAgentSkillRequest,
} from "./index.js";

const NOW = "2025-06-01T12:00:00.000Z";

describe("domain: per-persona agent assets (issue #315)", () => {
  it("contracts the six boot personas", () => {
    expect(PERSONAS).toEqual(["global-agent", "orchestrator", "worker", "researcher", "devex-audit", "kiss-audit"]);
    for (const persona of PERSONAS) expect(personaSchema.safeParse(persona).success).toBe(true);
    expect(personaSchema.safeParse("researcher").success).toBe(true);
    expect(personaSchema.safeParse("historian").success).toBe(false);
  });

  it("keeps skill ids slug-shaped (they become filenames)", () => {
    expect(agentSkillIdSchema.safeParse("prd").success).toBe(true);
    expect(agentSkillIdSchema.safeParse("my_skill-2").success).toBe(true);
    expect(agentSkillIdSchema.safeParse("../escape").success).toBe(false);
    expect(agentSkillIdSchema.safeParse("-lead").success).toBe(false);
    expect(agentSkillIdSchema.safeParse("").success).toBe(false);
  });

  it("parses the full asset state: overrides, skills, and shipped defaults", () => {
    const assets: AgentAssets = agentAssetsSchema.parse({
      prompts: [{ persona: "orchestrator", content: "My orchestrator", updatedAt: NOW }],
      skills: [{ id: "prd", content: "---\nname: prd\ndescription: Write PRDs\n---\nbody", personas: ["orchestrator", "worker"], updatedAt: NOW }],
      defaults: Object.fromEntries(PERSONAS.map((persona) => [persona, `# ${persona} default`])),
    });
    expect(assets.prompts).toHaveLength(1);
    expect(assets.skills[0]?.personas).toEqual(["orchestrator", "worker"]);
    expect(assets.defaults["worker"]).toBe("# worker default");
  });

  it("accepts a skill applied to no personas (created-but-unapplied)", () => {
    const skill: AgentSkill = agentAssetsSchema.shape.skills.element.parse({
      id: "idle-skill",
      content: "---\nname: idle\ndescription: unused\n---\n",
      personas: [],
      updatedAt: NOW,
    });
    expect(skill.personas).toEqual([]);
  });

  it("keeps request bodies minimal: content for prompts, content+personas for skills", () => {
    expect(saveAgentSkillRequestSchema.safeParse({ content: "x", personas: ["worker"] }).success).toBe(true);
    expect(saveAgentSkillRequestSchema.safeParse({ content: "x", personas: ["nope"] }).success).toBe(false);
  });

  it("exposes the five agent-assets endpoints with typed bodies", () => {
    expect(endpoints.getAgentAssets.path).toBe("/api/agent-assets");
    expect(endpoints.savePromptOverride.method).toBe("PUT");
    expect(endpoints.deletePromptOverride.method).toBe("DELETE");
    expect(endpoints.saveAgentSkill.path).toBe("/api/agent-assets/skills/:skillId");
    expect(endpoints.deleteAgentSkill.method).toBe("DELETE");

    expectTypeOf<EndpointRequest<"savePromptOverride">>().toEqualTypeOf<{ content: string }>();
    expectTypeOf<EndpointRequest<"saveAgentSkill">>().toEqualTypeOf<SaveAgentSkillRequest>();
    expectTypeOf<EndpointResponse<"getAgentAssets">>().toEqualTypeOf<AgentAssets>();
    expectTypeOf<EndpointResponse<"savePromptOverride">>().toEqualTypeOf<PromptOverride>();
    expectTypeOf<EndpointResponse<"deleteAgentSkill">>().toEqualTypeOf<undefined>();

    expect(formatPath("savePromptOverride", { persona: "global-agent" })).toBe("/api/agent-assets/prompts/global-agent");
    expect(formatPath("saveAgentSkill", { skillId: "prd" })).toBe("/api/agent-assets/skills/prd");
    expect(formatPath("deleteAgentSkill", { skillId: "prd" })).toBe("/api/agent-assets/skills/prd");
  });
});
