/**
 * Agent-kind registry v2 (issue #330, docs/agent-kinds.md): resolution
 * order — stored kinds (user kinds and, since #368, shipped-kind
 * overrides) resolve ahead of shipped, and tombstoned shipped kinds do not
 * resolve at all (issue #368) — shipped kinds as spec-v2 data (the
 * dogfood check), and the auto-task column (issue #329): autonomous kinds
 * carry a taskTemplate that is typed after the persona boot; the
 * researcher is task-less by config (it waits for its caller's question)
 * and renders no task at all.
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

describe("shipped kinds are user-editable and user-deletable (issue #368)", () => {
  it("resolves a stored override ahead of its shipped spec (shadowing)", () => {
    const store = new AgentKindStore(stateDir);
    const override = userKind("researcher", { label: "my researcher" });
    store.save(override);
    const registry = new AgentKindRegistry(store);
    expect(registry.get("researcher")).toEqual(override);
    // Listed ONCE — the override shadows the shipped spec in the listing
    // (the shipped entry is dropped; the override keeps its stored position).
    expect(registry.list().filter((kind) => kind.name === "researcher")).toHaveLength(1);
    expect(registry.list().find((kind) => kind.name === "researcher")).toEqual(override);
    // isShipped still answers for the name (the persona-override surface keys on it).
    expect(registry.isShipped("researcher")).toBe(true);
  });

  it("tombstoning a shipped kind stops its resolution and listing", () => {
    const store = new AgentKindStore(stateDir);
    store.delete("devex-audit");
    const registry = new AgentKindRegistry(store);
    expect(registry.get("devex-audit")).toBeUndefined();
    expect(registry.list().map((kind) => kind.name)).not.toContain("devex-audit");
    expect(registry.isTombstoned("devex-audit")).toBe(true);
    // Other shipped kinds are untouched.
    expect(registry.get("researcher")).toBeDefined();
  });

  it("saving an override lifts the tombstone (re-creating a deleted shipped kind)", () => {
    const store = new AgentKindStore(stateDir);
    store.delete("kiss-audit");
    expect(store.isTombstoned("kiss-audit")).toBe(true);
    store.save(userKind("kiss-audit"));
    expect(store.isTombstoned("kiss-audit")).toBe(false);
    expect(new AgentKindRegistry(store).get("kiss-audit")).toBeDefined();
  });

  it("a tombstone for an unknown name is harmless", () => {
    const store = new AgentKindStore(stateDir);
    store.delete("never-shipped");
    expect(store.isTombstoned("never-shipped")).toBe(false); // not shipped — no tombstone recorded
    expect(store.delete("ghost")).toBe(false);
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

  it("persists shipped-kind tombstones and overrides across reloads (issue #368)", () => {
    const first = new AgentKindStore(stateDir);
    first.delete("researcher");
    const override = userKind("kiss-audit", { label: "my audit" });
    first.save(override);

    const second = new AgentKindStore(stateDir);
    expect(second.isTombstoned("researcher")).toBe(true);
    expect(second.get("kiss-audit")).toEqual(override);
    // The pre-#368 file shape (no tombstones field) still loads.
    expect(second.get("historian")).toBeUndefined();
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
