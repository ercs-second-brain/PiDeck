import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionSchema, type Session } from "@pideck/shared";
import { contextPercent, sessionDirSlug } from "./context.js";

const CWD = "/repo/worktrees/w1";

function session(): Session {
  return SessionSchema.parse({
    id: "s1",
    persona: "worker",
    projectId: "proj",
    tmuxSession: "pideck-s1",
    spawnedAt: new Date().toISOString(),
    model: null,
  });
}

function jsonlLine(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

function sessionHeader(): string {
  return jsonlLine({ type: "session", version: 3, id: "abc", timestamp: "t", cwd: CWD });
}

function modelChange(provider: string, modelId: string): string {
  return jsonlLine({ type: "model_change", id: "m1", parentId: null, timestamp: "t", provider, modelId });
}

function assistantUsage(usage: Record<string, unknown>, stopReason = "toolUse"): string {
  return jsonlLine({
    type: "message",
    id: "a1",
    parentId: "m1",
    timestamp: "t",
    message: { role: "assistant", content: [], stopReason, usage },
  });
}

function compaction(): string {
  return jsonlLine({ type: "compaction", id: "c1", parentId: "a1", timestamp: "t", summary: "s" });
}

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pideck-context-"));
  mkdirSync(join(agentDir, "sessions", sessionDirSlug(CWD)), { recursive: true });
});

function writeSession(lines: string[], name = "2026-01-01T00-00-00-000Z_0000.jsonl"): void {
  writeFileSync(join(agentDir, "sessions", sessionDirSlug(CWD), name), lines.join(""), "utf8");
}

function writeModelsStore(models: Array<Record<string, unknown>>, provider = "anthropic"): void {
  writeFileSync(
    join(agentDir, "models-store.json"),
    JSON.stringify({ [provider]: { models } }),
    "utf8",
  );
}

const MODEL = [{ id: "claude", contextWindow: 200000 }];

describe("sessionDirSlug", () => {
  it("matches pi's slug rule", () => {
    expect(sessionDirSlug("/home/me")).toBe("--home-me--");
    expect(sessionDirSlug("/a/b:c\\d")).toBe("--a-b-c-d--");
  });
});

describe("contextPercent", () => {
  it("computes percent from the latest assistant usage and the model catalog", () => {
    writeSession([
      sessionHeader(),
      modelChange("anthropic", "claude"),
      assistantUsage({ input: 100, output: 50, cacheRead: 400, cacheWrite: 0, totalTokens: 550 }),
    ]);
    writeModelsStore(MODEL);
    expect(contextPercent(session(), { cwd: CWD, agentDir })).toBe(0.3);
  });

  it("falls back to input+output+cacheRead+cacheWrite without totalTokens", () => {
    writeSession([
      sessionHeader(),
      modelChange("anthropic", "claude"),
      assistantUsage({ input: 100, output: 50, cacheRead: 400, cacheWrite: 0 }),
    ]);
    writeModelsStore(MODEL);
    expect(contextPercent(session(), { cwd: CWD, agentDir })).toBe(0.3);
  });

  it("uses the latest usage entry, not the first", () => {
    writeSession([
      sessionHeader(),
      modelChange("anthropic", "claude"),
      assistantUsage({ totalTokens: 10000 }),
      assistantUsage({ totalTokens: 100000 }),
    ]);
    writeModelsStore(MODEL);
    expect(contextPercent(session(), { cwd: CWD, agentDir })).toBe(50);
  });

  it("tracks model switches", () => {
    writeSession([
      sessionHeader(),
      modelChange("anthropic", "claude"),
      assistantUsage({ totalTokens: 50000 }),
      modelChange("other", "big"),
      assistantUsage({ totalTokens: 50000 }),
    ]);
    writeModelsStore([{ id: "big", contextWindow: 1000000 }], "other");
    expect(contextPercent(session(), { cwd: CWD, agentDir })).toBe(5);
  });

  it("returns null with no session file for the cwd", () => {
    expect(contextPercent(session(), { cwd: "/somewhere/else", agentDir })).toBeNull();
  });

  it("returns null with no assistant usage yet", () => {
    writeSession([sessionHeader(), modelChange("anthropic", "claude")]);
    writeModelsStore(MODEL);
    expect(contextPercent(session(), { cwd: CWD, agentDir })).toBeNull();
  });

  it("returns null for an unknown model or missing context window", () => {
    writeSession([sessionHeader(), modelChange("anthropic", "unknown"), assistantUsage({ totalTokens: 5 })]);
    writeModelsStore(MODEL);
    expect(contextPercent(session(), { cwd: CWD, agentDir })).toBeNull();

    writeSession([sessionHeader(), modelChange("anthropic", "claude"), assistantUsage({ totalTokens: 5 })]);
    writeModelsStore([{ id: "claude" }]);
    expect(contextPercent(session(), { cwd: CWD, agentDir })).toBeNull();
  });

  it("returns null when a compaction trails the last usage", () => {
    writeSession([
      sessionHeader(),
      modelChange("anthropic", "claude"),
      assistantUsage({ totalTokens: 100000 }),
      compaction(),
    ]);
    writeModelsStore(MODEL);
    expect(contextPercent(session(), { cwd: CWD, agentDir })).toBeNull();
  });

  it("returns null without a models-store.json", () => {
    writeSession([sessionHeader(), modelChange("anthropic", "claude"), assistantUsage({ totalTokens: 5 })]);
    expect(contextPercent(session(), { cwd: CWD, agentDir })).toBeNull();
  });

  it("ignores aborted and error assistant turns", () => {
    writeSession([
      sessionHeader(),
      modelChange("anthropic", "claude"),
      assistantUsage({ totalTokens: 9999 }, "aborted"),
      assistantUsage({ totalTokens: 9999 }, "error"),
    ]);
    writeModelsStore(MODEL);
    expect(contextPercent(session(), { cwd: CWD, agentDir })).toBeNull();
  });

  it("picks the newest session file in the cwd dir", () => {
    writeSession([sessionHeader(), modelChange("anthropic", "claude"), assistantUsage({ totalTokens: 1 })], "old.jsonl");
    writeSession([sessionHeader(), modelChange("anthropic", "claude"), assistantUsage({ totalTokens: 100000 })], "new.jsonl");
    utimesSync(join(agentDir, "sessions", sessionDirSlug(CWD), "new.jsonl"), new Date(), new Date(Date.now() + 5000));
    writeModelsStore(MODEL);
    expect(contextPercent(session(), { cwd: CWD, agentDir })).toBe(50);
  });
});
