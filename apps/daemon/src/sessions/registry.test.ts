import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionSchema, type Session } from "@pideck/shared";
import { SessionRegistry } from "./registry.js";

function record(overrides: Partial<Session> = {}): Session {
  return SessionSchema.parse({
    id: overrides.id ?? crypto.randomUUID(),
    persona: "worker",
    projectId: "proj",
    tmuxSession: `pideck-${overrides.id ?? "x"}`,
    spawnedAt: new Date().toISOString(),
    model: null,
    ...overrides,
  });
}

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "pideck-registry-"));
});

afterEach(() => {
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

describe("SessionRegistry", () => {
  it("starts empty when no file exists and round-trips records", () => {
    const registry = new SessionRegistry(stateDir);
    expect(registry.all()).toEqual([]);

    const session = record();
    registry.add(session);
    expect(registry.get(session.id)).toEqual(session);

    const reloaded = new SessionRegistry(stateDir);
    expect(reloaded.all()).toEqual([session]);
  });

  it("fills watermarks defaults on load", () => {
    new SessionRegistry(stateDir).add(record());
    const session = new SessionRegistry(stateDir).all()[0]!;
    expect(session.lastPromptedHeadSha).toBeNull();
    expect(session.fixAttempts).toBe(0);
  });

  it("lists by project and persona, and by archived state", () => {
    const registry = new SessionRegistry(stateDir);
    const worker = record({ id: "w1", persona: "worker", projectId: "a" });
    const orchestrator = record({ id: "o1", persona: "orchestrator", projectId: "a" });
    const other = record({ id: "w2", persona: "worker", projectId: "b" });
    registry.add(worker);
    registry.add(orchestrator);
    registry.add(other);
    registry.archive(other.id);

    expect(registry.list({ projectId: "a" }).map((s) => s.id)).toEqual(["w1", "o1"]);
    expect(registry.list({ persona: "worker", projectId: "b" }).map((s) => s.id)).toEqual(["w2"]);
    expect(registry.list({ archived: false }).map((s) => s.id)).toEqual(["w1", "o1"]);
    expect(registry.list({ archived: true }).map((s) => s.id)).toEqual(["w2"]);
    expect(registry.list().map((s) => s.id)).toEqual(["w1", "o1", "w2"]);
  });

  it("updates watermarks", () => {
    const registry = new SessionRegistry(stateDir);
    const session = record();
    registry.add(session);
    const updated = registry.update(session.id, {
      lastPromptedHeadSha: "abc123",
      lastDeliveredIssueCommentId: 42,
      fixAttempts: 2,
      lastActivityAt: new Date().toISOString(),
    });
    expect(updated.lastPromptedHeadSha).toBe("abc123");
    expect(updated.lastDeliveredIssueCommentId).toBe(42);
    expect(updated.fixAttempts).toBe(2);
    expect(registry.get(session.id)).toEqual(updated);
  });

  it("updates a label", () => {
    const registry = new SessionRegistry(stateDir);
    const session = record();
    registry.add(session);
    const updated = registry.update(session.id, { label: "Rate limiting" });
    expect(updated.label).toBe("Rate limiting");
    expect(registry.get(session.id)?.label).toBe("Rate limiting");
  });

  it("update on an unknown session throws", () => {
    expect(() => new SessionRegistry(stateDir).update("nope", {})).toThrow("unknown session");
  });

  it("archive sets archivedAt and keeps the record; twice is idempotent", () => {
    const registry = new SessionRegistry(stateDir);
    const session = record();
    registry.add(session);
    const archived = registry.archive(session.id);
    expect(archived.archivedAt).toEqual(expect.any(String));
    expect(registry.get(session.id)?.persona).toBe("worker");
    expect(registry.archive(session.id)).toEqual(archived);
  });
});
