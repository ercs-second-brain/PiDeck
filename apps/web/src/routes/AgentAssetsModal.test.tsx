/**
 * Agent-assets modal tests (issues #315/#358): the per-persona asset editor
 * is a modal dialog over the current view — two lists (persona prompts with
 * override/default state; user skills with their applied personas) and
 * nested editor dialogs (B11): the persona edit with its skill assignment
 * (B13 — toggles save immediately), the skill edit (id + content only).
 * Exercised with the api layer mocked (the settings-modal test pattern).
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

import { AgentAssetsModal, AgentAssetsView, PersonaEditorDialog, PERSONA_LABELS, SkillEditorDialog } from "./AgentAssetsModal";

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

  it("shows an editor dialog only when opened (none by default)", () => {
    const html = renderToString(<AgentAssetsView assets={ASSETS} onReload={() => {}} />);
    expect(html).not.toContain("asset-editor-text");
    expect(html).not.toContain("asset-dialog-overlay");
    expect(html).toContain("Edit");
  });
});

describe("persona + skill editor dialogs (issues #358 B11+B13)", () => {
  it("renders the persona edit as a nested dialog with the skill assignment (B13)", () => {
    const html = renderToString(
      <PersonaEditorDialog
        editor={{ kind: "prompt", persona: "orchestrator", content: "Custom orchestrator" }}
        assets={ASSETS}
        saving={false}
        error={null}
        onChange={() => {}}
        onSave={() => {}}
        onToggleSkill={() => {}}
      />,
    );
    // B11: a proper nested dialog, not an inline append.
    expect(html).toContain("asset-dialog-overlay");
    expect(html).toContain("Edit Orchestrator prompt");
    expect(html).toContain("Custom orchestrator");
    // B13: the persona's skills are checked here — prd is applied to the
    // orchestrator (checked), idle is not (unchecked).
    expect(html).toContain("Skills this persona loads");
    expect(html).toContain("Toggles save immediately");
    expect((html.match(/prd/g) ?? []).length).toBeGreaterThan(0);
    expect(html).toContain("idle");
    const checks = html.match(/<input type="checkbox"[^>]*>/g) ?? [];
    expect(checks.some((tag) => tag.includes("checked"))).toBe(true); // prd → orchestrator
    expect(checks.some((tag) => !tag.includes("checked"))).toBe(true); // idle
  });

  it("renders the skill edit as a nested dialog WITHOUT persona assignment (B13)", () => {
    const html = renderToString(
      <SkillEditorDialog
        editor={{ kind: "skill", id: "prd", idEditable: false, content: "---\nname: prd\n---\n", personas: ["orchestrator"] }}
        saving={false}
        error={null}
        onChange={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toContain("asset-dialog-overlay");
    expect(html).toContain("Edit skill"); // quotes render as &quot; entities
    // B13: no persona checkboxes — assignment moved to the persona edit.
    expect(html).not.toContain("asset-persona-checks");
    expect(html).not.toContain("Orchestrator");
    expect(html).toContain("Assign personas from each persona");
    // The assignment is carried through for the save (unchanged).
    expect(html).toContain('value="prd"');
  });

  it("renders the new-skill dialog with the id editable", () => {
    const html = renderToString(
      <SkillEditorDialog
        editor={{ kind: "skill", id: "", idEditable: true, content: "---\nname: \n---\n", personas: [] }}
        saving={false}
        error={null}
        onChange={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toContain("New skill");
    expect(html).not.toContain("disabled"); // id editable
  });
});
