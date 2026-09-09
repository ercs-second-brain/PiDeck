/**
 * Contract test for the agent-kind presentation metadata (issue #324,
 * deep audit #295 findings 2-5): the shared AGENT_KIND_INFO table the web
 * ⋯-menu, the sidebar naming, and the input rules render from — adding a
 * kind touches this table + a persona file, nothing else
 * (docs/agent-kinds.md). Lives in its own file to keep index.test.ts
 * within its max-lines budget.
 */

import { describe, expect, it } from "vitest";
import { AGENT_KIND_INFO, AGENT_KIND_REPORT_TARGET, AGENT_KINDS, type AgentKind } from "./index.js";

describe("AGENT_KIND_INFO (issue #324)", () => {
  it("carries complete metadata for every kind", () => {
    // Keyed by the enum — a missing kind is a type error; every kind has
    // label/menu text/description/input rule plus a report target.
    const kinds: readonly AgentKind[] = AGENT_KINDS;
    for (const kind of kinds) {
      const info = AGENT_KIND_INFO[kind];
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.menuLabel.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(0);
      expect(typeof info.takesInput).toBe("boolean");
      expect(AGENT_KIND_REPORT_TARGET[kind]).toMatch(/^(caller|project-orchestrator)$/);
    }
  });

  it("marks the investigator as the one kind that takes input", () => {
    expect(AGENT_KIND_INFO.investigator.takesInput).toBe(true);
    expect(AGENT_KIND_INFO["devex-audit"].takesInput).toBe(false);
    expect(AGENT_KIND_INFO["kiss-audit"].takesInput).toBe(false);
  });
});
