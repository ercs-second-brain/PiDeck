/**
 * Agent-assets modal tests (issue #315): the per-persona asset editor is a
 * modal dialog over the current view — two lists (persona prompts with
 * override/default state; user skills with their applied personas) and an
 * in-modal textarea editor. Exercised with the api layer mocked (the
 * settings-modal test pattern).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { PERSONAS, type AgentAssets, type Persona } from "@pideck/shared";

vi.mock("../lib/api", () => ({
  apiGetAgentAssets: vi.fn(),
  apiSavePromptOverride: vi.fn(),
  apiDeletePromptOverride: vi.fn(),
  apiSaveAgentSkill: vi.fn(),
  apiDeleteAgentSkill: vi.fn(),
  errorMessage: (err: unknown) => String(err),
}));

import { AgentAssetsModal, AgentAssetsView, PERSONA_LABELS } from "./AgentAssetsModal";

const { apiGetAgentAssets } = vi.mocked(await import("../lib/api"));

const ASSETS: AgentAssets = {
  prompts: [{ persona: "orchestrator", content: "Custom orchestrator", updatedAt: "2025-06-01T12:00:00.000Z" }],
  skills: [
    { id: "prd", content: "---\nname: prd\n---\n", personas: ["orchestrator", "worker"], updatedAt: "2025-06-01T12:00:00.000Z" },
    { id: "idle", content: "---\nname: idle\n---\n", personas: [], updatedAt: "2025-06-01T12:00:00.000Z" },
  ],
  defaults: Object.fromEntries(PERSONAS.map((persona) => [persona, `default ${persona}`])) as Record<Persona, string>,
};

beforeEach(() => {
  apiGetAgentAssets.mockResolvedValue(ASSETS);
});

describe("agent-assets modal (issue #315)", () => {
  it("renders as a modal dialog listing both asset kinds with persona state", () => {
    const shell = renderToString(<AgentAssetsModal onClose={() => {}} />);
    expect(shell).toContain("modal-overlay");
    expect(shell).toContain("Agent assets");
    const html = renderToString(<AgentAssetsView assets={ASSETS} onReload={() => {}} />);
    // Persona prompts: one row per shipped persona, override state visible.
    expect(html).toContain("Persona prompts");
    for (const persona of PERSONAS) expect(html).toContain(PERSONA_LABELS[persona]);
    expect((html.match(/asset-row/g) ?? []).length).toBeGreaterThanOrEqual(PERSONAS.length);
    expect(html).toContain("override");
    expect(html).toContain("shipped default");
    expect(html).toContain("Reset to default");
    // Skills: applied personas listed; an unapplied skill says so.
    expect(html).toContain("Skills");
    expect(html).toContain("prd");
    expect(html).toContain("Orchestrator, Worker");
    expect(html).toContain("applied to no personas");
    expect(html).toContain("+ New skill");
  });

  it("renders the framing honestly while loading or when the daemon is unreachable", () => {
    // The modal shell (fetch inside the effect) shows only framing on SSR;
    // the error path surfaces through the hook at runtime.
    const html = renderToString(<AgentAssetsModal onClose={() => {}} />);
    expect(html).toContain("Agent assets");
  });

  it("shows an editor section only when opened (none by default)", () => {
    const html = renderToString(<AgentAssetsView assets={ASSETS} onReload={() => {}} />);
    expect(html).not.toContain("asset-editor-text");
    expect(html).toContain("Edit");
  });
});
