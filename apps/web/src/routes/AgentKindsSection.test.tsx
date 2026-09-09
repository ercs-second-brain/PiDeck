/**
 * Agent-kinds section tests (issue #332): the registry-v2 persona editor in
 * the agent-assets modal. Exercised with the api layer mocked and pure
 * subcomponents rendered via `renderToString` (the settings-modal test
 * pattern) — `KindRows` for the list, `AgentKindForm` for the config form,
 * `parseDraft` for the shared-schema validation, and the self-fetching
 * section shell for its framing states.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { SHIPPED_AGENT_KINDS, type AgentKindSpec } from "@pideck/shared";

vi.mock("../lib/api", () => ({
  apiListAgentKinds: vi.fn(),
  apiCreateAgentKind: vi.fn(),
  apiUpdateAgentKind: vi.fn(),
  apiDeleteAgentKind: vi.fn(),
  errorMessage: (err: unknown) => String(err),
}));

import { AgentKindForm, parseDraft, type KindDraft } from "./AgentKindForm";
import { AgentKindsSection, KindRows } from "./AgentKindsSection";

const { apiListAgentKinds } = vi.mocked(await import("../lib/api"));

const USER_KIND: AgentKindSpec = {
  name: "docs-writer",
  label: "docs-writer",
  persona: "You write documentation.",
  spawnableBy: ["orchestrator"],
  callerWaits: true,
  readOnly: false,
  trigger: "auto",
  taskTemplate: "Write the docs for {{PROJECT_NAME}}.",
  reportTarget: "orchestrator",
  workerLike: true,
};

const KINDS: AgentKindSpec[] = [...SHIPPED_AGENT_KINDS.slice(0, 1), USER_KIND];

beforeEach(() => {
  apiListAgentKinds.mockResolvedValue({ kinds: KINDS });
});

const DRAFT: KindDraft = {
  name: "docs-writer",
  label: "docs-writer",
  persona: "You write documentation.",
  spawnableBy: ["orchestrator", "worker"],
  callerWaits: true,
  readOnly: false,
  trigger: "auto",
  taskTemplate: "Write the docs.",
  reportTarget: "orchestrator",
  workerLike: true,
};

describe("agent-kinds section (issue #332)", () => {
  it("lists every registry kind with shipped/custom chips and per-kind state", () => {
    const html = renderToString(
      <KindRows kinds={KINDS} onEdit={() => {}} onDelete={() => {}} confirmingDeleteName={null} />,
    );
    expect((html.match(/asset-row/g) ?? []).length).toBe(KINDS.length);
    // Shipped kind: chip, no edit/delete actions.
    expect(html).toContain("Researcher");
    expect(html).toContain("shipped");
    // Custom kind: chip plus the edit/delete actions.
    expect(html).toContain("docs-writer");
    expect(html).toContain("custom");
    expect(html).toContain("Delete");
    const confirming = renderToString(
      <KindRows kinds={KINDS} onEdit={() => {}} onDelete={() => {}} confirmingDeleteName="docs-writer" />,
    );
    expect(confirming).toContain("Confirm delete?");
    expect(html).toContain("auto"); // trigger summary
    expect(html).toContain("the orchestrator"); // report-target summary
  });

  it("renders the config form with every spec-v2 field", () => {
    const html = renderToString(
      <AgentKindForm
        draft={DRAFT}
        editing
        saving={false}
        error={null}
        onChange={() => {}}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("Edit agent kind &quot;docs-writer&quot;");
    expect(html).toContain("You write documentation."); // persona textarea value
    expect(html).toContain("Write the docs."); // task template (trigger auto)
    expect(html).toContain("Spawnable by");
    expect(html).toContain("Global agent");
    expect(html).toContain("Caller waits for the report");
    expect(html).toContain("Read-only");
    expect(html).toContain("Worker-like");
    expect(html).toContain('value="caller"');
    expect(html).toContain('value="orchestrator"');
    // Editing pins the kind id; create shows it editable.
    expect(html).toContain('disabled=""');
  });

  it("hides the task template for waitForInput drafts", () => {
    const html = renderToString(
      <AgentKindForm
        draft={{ ...DRAFT, trigger: "waitForInput" }}
        editing={false}
        saving={false}
        error={null}
        onChange={() => {}}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).not.toContain("Task template");
    expect(html).toContain("New agent kind");
  });

  it("validates drafts against the shared upsert schema", () => {
    expect(typeof parseDraft(DRAFT)).toBe("object");
    // Bad kind id, empty persona, missing task template for auto.
    expect(parseDraft({ ...DRAFT, name: "Docs Writer" })).toContain("kebab-case");
    expect(parseDraft({ ...DRAFT, persona: "" })).toContain("persona");
    expect(parseDraft({ ...DRAFT, taskTemplate: "" })).toContain("taskTemplate");
    // waitForInput drafts never carry a template (the form drops it).
    const reactive = { ...DRAFT, trigger: "waitForInput" as const, taskTemplate: "leftover" };
    expect(JSON.stringify(parseDraft(reactive))).not.toContain("leftover");
    expect(parseDraft({ ...reactive, taskTemplate: "" })).toEqual({
      name: "docs-writer",
      label: "docs-writer",
      persona: "You write documentation.",
      spawnableBy: ["orchestrator", "worker"],
      callerWaits: true,
      readOnly: false,
      trigger: "waitForInput",
      reportTarget: "orchestrator",
      workerLike: true,
    });
  });

  it("renders the self-fetching section shell with framing while loading", () => {
    const html = renderToString(<AgentKindsSection />);
    expect(html).toContain("Agent kinds");
    expect(html).toContain("+ New kind");
    expect(html).not.toContain("asset-row"); // kinds arrive via the effect (SSR: none yet)
  });
});
