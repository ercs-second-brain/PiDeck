/**
 * Contract test for the agent-kind registry v2 (issue #330,
 * docs/agent-kinds.md): the shipped kinds are spec-v2 data — the schema
 * must be able to represent them verbatim (dogfood) — and the derived
 * presentation tables (issue #324) stay consistent. User kinds are
 * validated by the same schema; the daemon-side registry/store have their
 * own tests. Lives in its own file to keep index.test.ts within its
 * max-lines budget.
 */

import { describe, expect, it } from "vitest";
import {
  agentKindInfo,
  agentKindSpecSchema,
  AGENT_KINDS,
  SHIPPED_AGENT_KINDS,
  upsertAgentKindRequestSchema,
} from "./index.js";

describe("SHIPPED_AGENT_KINDS (spec v2, issue #330)", () => {
  it("dogfoods: every shipped kind validates against the spec-v2 schema verbatim", () => {
    for (const kind of SHIPPED_AGENT_KINDS) {
      const parsed = agentKindSpecSchema.safeParse(kind);
      expect(parsed.success, `${kind.name} must be representable as spec-v2 data`).toBe(true);
    }
  });

  it("ships the three built-in kinds with stable ids", () => {
    expect(AGENT_KINDS).toEqual(["researcher", "devex-audit", "kiss-audit"]);
    expect(AGENT_KINDS).toHaveLength(SHIPPED_AGENT_KINDS.length);
  });

  it("encodes the shipped behavior matrix (trigger/reportTarget/readOnly/workerLike)", () => {
    const researcher = SHIPPED_AGENT_KINDS.find((k) => k.name === "researcher");
    expect(researcher).toBeDefined();
    const r = researcher!;
    expect(r.trigger).toBe("waitForInput"); // waits for the caller's question
    expect(r.taskTemplate).toBeUndefined(); // task-less by config (#329)
    expect(r.reportTarget).toBe("caller");
    expect(r.callerWaits).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.workerLike).toBe(false);

    for (const audit of SHIPPED_AGENT_KINDS.filter((k) => k.name.endsWith("audit"))) {
      expect(audit.trigger).toBe("auto");
      expect(audit.taskTemplate).toBeDefined();
      expect(audit.reportTarget).toBe("orchestrator");
      expect(audit.readOnly).toBe(true);
      expect(audit.workerLike).toBe(true);
    }
  });

  it("lets every role spawn the shipped kinds (back-compat: nothing is restricted)", () => {
    for (const kind of SHIPPED_AGENT_KINDS) {
      expect(kind.spawnableBy).toEqual(["global", "orchestrator", "worker", "reviewer"]);
    }
  });
});

describe("agentKindSpecSchema (spec v2)", () => {
  it("accepts a user-defined kind with persona content", () => {
    const parsed = agentKindSpecSchema.safeParse({
      name: "historian",
      label: "history",
      persona: "You are a project historian...",
      spawnableBy: ["orchestrator"],
      callerWaits: false,
      readOnly: true,
      trigger: "auto",
      taskTemplate: "Write the history of {{PROJECT_NAME}}.",
      reportTarget: "caller",
      workerLike: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("pairs trigger and taskTemplate: auto needs one, waitForInput takes none", () => {
    const base = {
      name: "historian",
      label: "history",
      persona: "p",
      spawnableBy: ["orchestrator"],
      callerWaits: false,
      readOnly: true,
      reportTarget: "caller",
      workerLike: false,
    };
    expect(agentKindSpecSchema.safeParse({ ...base, trigger: "auto" }).success).toBe(false);
    expect(agentKindSpecSchema.safeParse({ ...base, trigger: "auto", taskTemplate: "Go." }).success).toBe(true);
    expect(agentKindSpecSchema.safeParse({ ...base, trigger: "waitForInput", taskTemplate: "Go." }).success).toBe(false);
  });

  it("rejects ids that are not kebab-case slugs", () => {
    expect(
      agentKindSpecSchema.safeParse({
        name: "Bad Kind",
        label: "x",
        persona: "p",
        spawnableBy: ["worker"],
        callerWaits: false,
        readOnly: true,
        trigger: "waitForInput",
        reportTarget: "caller",
        workerLike: false,
      }).success,
    ).toBe(false);
  });
});

describe("upsertAgentKindRequestSchema (CRUD body, issue #330)", () => {
  const base = {
    name: "historian",
    label: "history",
    spawnableBy: ["orchestrator"],
    callerWaits: false,
    readOnly: true,
    trigger: "waitForInput",
    reportTarget: "caller",
    workerLike: false,
  };

  it("demands persona content from user-defined kinds", () => {
    expect(upsertAgentKindRequestSchema.safeParse(base).success).toBe(false);
    expect(upsertAgentKindRequestSchema.safeParse({ ...base, persona: "You are..." }).success).toBe(true);
  });
});

describe("AGENT_KIND_INFO / agentKindInfo (issue #324, derived per #330)", () => {
  it("carries complete metadata for every shipped kind", () => {
    for (const name of AGENT_KINDS) {
      const info = agentKindInfo(name);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.menuLabel.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(0);
      expect(typeof info.takesInput).toBe("boolean");
    }
  });

  it("marks the researcher as the one kind that takes input", () => {
    expect(agentKindInfo("researcher").takesInput).toBe(true);
    expect(agentKindInfo("devex-audit").takesInput).toBe(false);
    expect(agentKindInfo("kiss-audit").takesInput).toBe(false);
  });

  it("synthesizes safe metadata for user-defined kinds (the web never crashes on an unknown id)", () => {
    const info = agentKindInfo("historian");
    expect(info).toEqual({ label: "historian", menuLabel: "historian", description: 'Spawn the "historian" agent', takesInput: false });
    // Shipped kinds resolve through the same helper.
    expect(agentKindInfo("researcher")).toEqual(agentKindInfo("researcher"));
  });
});
