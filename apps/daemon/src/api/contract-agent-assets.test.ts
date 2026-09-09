/**
 * Contract test for the per-persona agent-asset endpoints (issue #315):
 * GET /api/agent-assets, PUT/DELETE prompt overrides, PUT/DELETE skills —
 * over real HTTP. The store itself is covered in `agent-assets.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentAssetsSchema, agentSkillSchema, endpoints, formatPath, promptOverrideSchema } from "@pideck/shared";

import { startContractServer, type ContractServer } from "./contract-fixtures.js";

let server: ContractServer;

beforeAll(async () => {
  server = await startContractServer();
});

afterAll(async () => {
  await server?.close();
});

describe("agent assets (issue #315)", () => {
  it("serves the full asset state with shipped defaults", async () => {
    const got = await server.api("GET", endpoints.getAgentAssets.path);
    expect(got.status).toBe(200);
    const assets = agentAssetsSchema.parse(got.json);
    expect(assets.prompts).toEqual([]);
    expect(assets.skills).toEqual([]);
    // Defaults come from the shipped agent/prompts files (repo walk-up).
    expect(assets.defaults["orchestrator"]).toContain("{{PROJECT_ID}}");
  });

  it("upserts, lists, and deletes a prompt override (404 once gone)", async () => {
    const { api } = server;
    const savePath = formatPath("savePromptOverride", { persona: "orchestrator" });
    const saved = await api("PUT", savePath, { content: "Custom orchestrator persona" });
    expect(saved.status).toBe(200);
    const override = promptOverrideSchema.parse(saved.json);
    expect(override).toMatchObject({ persona: "orchestrator", content: "Custom orchestrator persona" });

    const listed = await api("GET", endpoints.getAgentAssets.path);
    expect(agentAssetsSchema.parse(listed.json).prompts).toEqual([override]);

    // Unknown persona → 400 (contract path validation).
    expect((await api("PUT", "/api/agent-assets/prompts/historian", { content: "x" })).status).toBe(400);

    expect((await api("DELETE", savePath)).status).toBe(204);
    expect((await api("DELETE", savePath)).status).toBe(404);

    const after = await api("GET", endpoints.getAgentAssets.path);
    expect(agentAssetsSchema.parse(after.json).prompts).toEqual([]);
  });

  it("upserts, lists, and deletes skills with their persona applications", async () => {
    const { api } = server;
    const skillPath = formatPath("saveAgentSkill", { skillId: "prd" });
    const saved = await api("PUT", skillPath, { content: "---\nname: prd\ndescription: PRD\n---\nbody", personas: ["orchestrator", "worker"] });
    expect(saved.status).toBe(200);
    const skill = agentSkillSchema.parse(saved.json);
    expect(skill).toMatchObject({ id: "prd", personas: ["orchestrator", "worker"] });

    const listed = await api("GET", endpoints.getAgentAssets.path);
    expect(agentAssetsSchema.parse(listed.json).skills).toEqual([skill]);

    // Unapply + edit: a PUT with empty personas keeps the skill, applied nowhere.
    const updated = await api("PUT", skillPath, { content: "v2", personas: [] });
    expect(agentSkillSchema.parse(updated.json)).toMatchObject({ id: "prd", content: "v2", personas: [] });

    // Malformed skill id → 400 (contract path validation; encoded traversal).
    expect((await api("PUT", "/api/agent-assets/skills/..%2Fescape", { content: "x", personas: [] })).status).toBe(400);

    expect((await api("DELETE", skillPath)).status).toBe(204);
    expect((await api("DELETE", skillPath)).status).toBe(404);
  });
});
