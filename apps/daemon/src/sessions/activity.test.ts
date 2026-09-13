import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionActive } from "./activity.js";

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

const NOW = "2026-02-01T12:00:00.000Z";
/** An hour before NOW — far past any age-based window. */
const HOUR_AGO = "2026-02-01T11:00:00.000Z";

describe("sessionActive", () => {
  it("is active while a tool call runs, however long — the newest event is an in-flight turn", () => {
    writeSession([
      line({ type: "session" }, HOUR_AGO),
      assistant("toolUse", HOUR_AGO),
    ]);
    expect(sessionActive(stateDir, "s1")).toBe(true);
  });

  it("is active while the model generates its next step after a tool result, however long", () => {
    writeSession([assistant("toolUse", HOUR_AGO), toolResult(HOUR_AGO)]);
    expect(sessionActive(stateDir, "s1")).toBe(true);
  });

  it("is idle once the turn completes", () => {
    writeSession([
      assistant("toolUse", HOUR_AGO),
      toolResult(HOUR_AGO),
      assistant("stop", NOW),
    ]);
    expect(sessionActive(stateDir, "s1")).toBe(false);
  });

  it("is idle while the newest event is a user prompt waiting to be picked up", () => {
    writeSession([user(NOW)]);
    expect(sessionActive(stateDir, "s1")).toBe(false);
  });

  it("is idle for an aborted in-flight turn", () => {
    writeSession([assistant("aborted", NOW)]);
    expect(sessionActive(stateDir, "s1")).toBe(false);
  });

  it("is idle for a dead pane even with an in-flight transcript", () => {
    writeSession([assistant("toolUse", HOUR_AGO)]);
    expect(sessionActive(stateDir, "s1", false)).toBe(false);
  });

  it("skips a torn last line and reads the newest complete event", () => {
    writeSession([
      `${assistant("toolUse", NOW)}`,
      '{"type":"message","message":{"role":"assista',
    ]);
    expect(sessionActive(stateDir, "s1")).toBe(true);
  });

  it("reads the newest of several session files", () => {
    writeSession([assistant("stop", NOW)], "old.jsonl");
    writeSession([assistant("toolUse", NOW)], "new.jsonl");
    expect(sessionActive(stateDir, "s1")).toBe(true);
  });

  it("is idle without a session file", () => {
    expect(sessionActive(stateDir, "s1")).toBe(false);
  });

  it("is idle when the JSONL has no message events at all", () => {
    writeSession([line({ type: "session" }, NOW)]);
    expect(sessionActive(stateDir, "s1")).toBe(false);
  });
});
