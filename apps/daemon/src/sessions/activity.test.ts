import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionActive, ACTIVE_WINDOW_MS } from "./activity.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "pideck-activity-"));
});

afterEach(() => {
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

function line(entry: Record<string, unknown>, at: string): string {
  return `${JSON.stringify({ ...entry, timestamp: at })}\n`;
}

/** Writes one JSONL under the session's pinned pi dir. */
function writeSession(lines: string[], name = "2026-01-01T00-00-00-000Z_0000.jsonl"): string {
  const dir = join(stateDir, "pi-sessions", "s1");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, lines.join(""), "utf8");
  return file;
}

function assistant(stopReason: string, at: string): string {
  return `${JSON.stringify({
    type: "message",
    timestamp: at,
    message: { role: "assistant", content: [], stopReason },
  })}\n`;
}

function toolResult(at: string): string {
  return `${JSON.stringify({
    type: "message",
    timestamp: at,
    message: { role: "toolResult", content: [] },
  })}\n`;
}

function user(at: string): string {
  return `${JSON.stringify({
    type: "message",
    timestamp: at,
    message: { role: "user", content: [] },
  })}\n`;
}

const NOW = Date.parse("2026-02-01T12:00:00.000Z");

describe("sessionActive", () => {
  it("is active while the newest event is a fresh in-flight assistant turn", () => {
    writeSession([
      line({ type: "session" }, "2026-02-01T11:59:00.000Z"),
      assistant("toolUse", "2026-02-01T11:59:30.000Z"),
    ]);
    expect(sessionActive(stateDir, "s1", NOW)).toBe(true);
  });

  it("is active while a tool result is fresh — the turn is still in flight", () => {
    writeSession([assistant("toolUse", "2026-02-01T11:59:00.000Z"), toolResult("2026-02-01T11:59:40.000Z")]);
    expect(sessionActive(stateDir, "s1", NOW)).toBe(true);
  });

  it("is idle once the turn completes", () => {
    writeSession([
      assistant("toolUse", "2026-02-01T11:59:00.000Z"),
      toolResult("2026-02-01T11:59:10.000Z"),
      assistant("stop", "2026-02-01T11:59:59.000Z"),
    ]);
    expect(sessionActive(stateDir, "s1", NOW)).toBe(false);
  });

  it("is idle when the in-flight event ages past the window", () => {
    writeSession([assistant("toolUse", "2026-02-01T11:58:59.000Z")]);
    expect(sessionActive(stateDir, "s1", NOW)).toBe(false);
    writeSession([assistant("toolUse", "2026-02-01T11:59:01.000Z")]);
    expect(sessionActive(stateDir, "s1", NOW)).toBe(true);
  });

  it("is idle while the newest event is a user prompt waiting to be picked up", () => {
    writeSession([user("2026-02-01T11:59:59.000Z")]);
    expect(sessionActive(stateDir, "s1", NOW)).toBe(false);
  });

  it("is idle for an aborted in-flight turn", () => {
    writeSession([assistant("aborted", "2026-02-01T11:59:59.000Z")]);
    expect(sessionActive(stateDir, "s1", NOW)).toBe(false);
  });

  it("falls back to the file mtime when the event carries no usable timestamp", () => {
    const file = writeSession([JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "toolUse" } })]);
    const fresh = NOW - ACTIVE_WINDOW_MS / 2;
    utimesSync(file, new Date(fresh), new Date(fresh));
    expect(sessionActive(stateDir, "s1", NOW)).toBe(true);
    const stale = NOW - ACTIVE_WINDOW_MS * 2;
    utimesSync(file, new Date(stale), new Date(stale));
    expect(sessionActive(stateDir, "s1", NOW)).toBe(false);
  });

  it("falls back to the message's numeric timestamp when the event timestamp is not ISO", () => {
    const at = NOW - 1000;
    writeSession([
      `${JSON.stringify({ type: "session", timestamp: "t" })}\n`,
      `${JSON.stringify({ type: "message", timestamp: "t", message: { role: "assistant", stopReason: "toolUse", timestamp: at } })}\n`,
    ]);
    expect(sessionActive(stateDir, "s1", NOW)).toBe(true);
  });

  it("skips a torn last line and reads the newest complete event", () => {
    writeSession([
      `${assistant("toolUse", "2026-02-01T11:59:59.000Z")}`,
      '{"type":"message","message":{"role":"assista',
    ]);
    expect(sessionActive(stateDir, "s1", NOW)).toBe(true);
  });

  it("reads the newest of several session files", () => {
    writeSession([assistant("toolUse", "2026-02-01T11:00:00.000Z")], "old.jsonl");
    writeSession([assistant("toolUse", "2026-02-01T11:59:59.000Z")], "new.jsonl");
    expect(sessionActive(stateDir, "s1", NOW)).toBe(true);
  });

  it("is idle without a session file", () => {
    expect(sessionActive(stateDir, "s1", NOW)).toBe(false);
  });

  it("is idle when the JSONL has no message events at all", () => {
    writeSession([line({ type: "session" }, "2026-02-01T11:59:59.000Z")]);
    expect(sessionActive(stateDir, "s1", NOW)).toBe(false);
  });
});