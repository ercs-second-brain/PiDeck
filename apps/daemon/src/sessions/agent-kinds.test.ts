/**
 * Agent-kind registry v2 (issue #330, docs/agent-kinds.md): resolution
 * order (user kinds shadow nothing — shipped names are rejected at the
 * CRUD layer — but user kinds resolve ahead of shipped), shipped kinds as
 * spec-v2 data (the dogfood check), and the auto-task column (issue #329):
 * autonomous kinds carry a taskTemplate that is typed after the persona
 * boot; the researcher is task-less by config (it waits for its caller's
 * question) and renders no task at all.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { SHIPPED_AGENT_KINDS, type AgentKindSpec } from "@pideck/shared";

import { AgentKindStore } from "./agent-kind-store.js";
import { AgentKindRegistry, renderAgentKindTask } from "./agent-kinds.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "pideck-kind-registry-"));
});

/** A valid user-defined kind (persona content is mandatory for user kinds). */
function userKind(name: string, overrides: Record<string, unknown> = {}): AgentKindSpec {
  return {
    name,
    label: name,
    persona: `You are the ${name} agent.`,
    spawnableBy: ["orchestrator"],
    callerWaits: false,
    readOnly: true,
    trigger: "waitForInput",
    reportTarget: "caller",
    workerLike: false,
    ...overrides,
  } as AgentKindSpec;
}

describe("AgentKindRegistry (issue #330)", () => {
  it("resolves the shipped kinds as spec-v2 data (dogfood: no hardcoded names)", () => {
    const registry = new AgentKindRegistry();
    for (const shipped of SHIPPED_AGENT_KINDS) {
      expect(registry.get(shipped.name)).toEqual(shipped);
    }
    expect(registry.list().map((kind) => kind.name)).toEqual(SHIPPED_AGENT_KINDS.map((kind) => kind.name));
  });

  it("resolves user kinds from the store ahead of the shipped list", () => {
    const store = new AgentKindStore(stateDir);
    store.save(userKind("historian"));
    const registry = new AgentKindRegistry(store);
    expect(registry.get("historian")).toMatchObject({ name: "historian", persona: "You are the historian agent." });
    expect(registry.list().map((kind) => kind.name)).toEqual([...SHIPPED_AGENT_KINDS.map((k) => k.name), "historian"]);
  });

  it("answers isShipped for built-ins only (the CRUD guardrails read it)", () => {
    const store = new AgentKindStore(stateDir);
    store.save(userKind("historian"));
    const registry = new AgentKindRegistry(store);
    expect(registry.isShipped("kiss-audit")).toBe(true);
    expect(registry.isShipped("historian")).toBe(false);
  });

  it("sees store deletions immediately (delete guardrails gate on live sessions, not the registry)", () => {
    const store = new AgentKindStore(stateDir);
    store.save(userKind("historian"));
    const registry = new AgentKindRegistry(store);
    expect(registry.get("historian")).toBeDefined();
    store.delete("historian");
    expect(registry.get("historian")).toBeUndefined();
  });
});

describe("AgentKindStore (user kinds, issue #330)", () => {
  it("persists user kinds across reloads (update-safe state-dir file)", () => {
    const file = path.join(stateDir, "agent-kinds.json");
    const first = new AgentKindStore(stateDir);
    first.save(userKind("historian"));
    expect(first.save(userKind("historian", { label: "chronicle" })).label).toBe("chronicle");
    // A fresh instance over the same file (daemon reload) sees the state.
    const second = new AgentKindStore(stateDir);
    expect(second.get("historian")).toMatchObject({ label: "chronicle", name: "historian" });
    expect(second.list()).toHaveLength(1);
    expect(file.endsWith("agent-kinds.json")).toBe(true);
  });

  it("drops persisted specs that no longer match the schema instead of rejecting the file", () => {
    const file = path.join(stateDir, "agent-kinds.json");
    new AgentKindStore(stateDir).save(userKind("historian"));
    // Corrupt the persisted file: one valid spec, one drifted entry.
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.kinds.push({ name: "Bad Kind", label: "x" });
    writeFileSync(file, JSON.stringify(raw));
    const reloaded = new AgentKindStore(stateDir);
    expect(reloaded.list().map((kind) => kind.name)).toEqual(["historian"]);
  });

  it("reports false when deleting an unknown kind", () => {
    expect(new AgentKindStore(stateDir).delete("ghost")).toBe(false);
  });
});

describe("agent-kind auto-task rendering (issue #329)", () => {
  it("renders the task with the persona's placeholder set (project + report target)", () => {
    const spec = SHIPPED_AGENT_KINDS.find((kind) => kind.name === "kiss-audit")!;
    const rendered = renderAgentKindTask(spec, {
      PROJECT_PATH: "/state/projects/ak/clone",
      ORCHESTRATOR_SESSION_ID: "sess-orch-9",
    });
    expect(rendered).toContain("audit the project at /state/projects/ak/clone");
    expect(rendered).toContain("pideck send --session sess-orch-9");
    expect(rendered).not.toContain("{{");
  });

  it("renders nothing for task-less kinds — no auto-task is typed after the boot", () => {
    const spec = SHIPPED_AGENT_KINDS.find((kind) => kind.name === "researcher")!;
    expect(renderAgentKindTask(spec, { PROJECT_PATH: "/x" })).toBeUndefined();
  });
});
