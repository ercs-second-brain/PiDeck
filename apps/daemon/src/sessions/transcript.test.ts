import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTranscript } from "./transcript.js";
import { PI_TRANSCRIPT_JSONL } from "./testFixture.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "pideck-transcript-"));
});

afterEach(() => {
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

function writeSession(lines: string[], name = "2026-01-01T00-00-00-000Z_0000.jsonl"): void {
  mkdirSync(join(stateDir, "pi-sessions", "s1"), { recursive: true });
  writeFileSync(join(stateDir, "pi-sessions", "s1", name), lines.join(""), "utf8");
}

describe("readTranscript", () => {
  it("parses the captured pi transcript fixture: roles, timestamps, tool call summary", () => {
    mkdirSync(join(stateDir, "pi-sessions", "s1"), { recursive: true });
    writeFileSync(join(stateDir, "pi-sessions", "s1", "real.jsonl"), PI_TRANSCRIPT_JSONL, "utf8");
    const { entries } = readTranscript(stateDir, "s1");
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ role: "user", at: "2026-01-01T00:00:01.000Z", text: "Run the shell command 'echo hi' and then stop." });
    expect(entries[1]).toMatchObject({ role: "tool", text: 'bash({"command":"echo hi"})' });
    expect(entries[2]).toMatchObject({ role: "assistant", text: "The command output `hi`, as expected. Stopping here as requested." });
  });

  it("returns no entries when the session dir has no pi JSONL", () => {
    expect(readTranscript(stateDir, "s1")).toEqual({ entries: [] });
  });

  it("returns no entries for a session dir that does not exist", () => {
    expect(readTranscript(stateDir, "gone")).toEqual({ entries: [] });
  });

  it("skips header, model-change, compaction, tool-result, and torn lines", () => {
    writeSession([
      '{"type":"session","version":3}\n',
      '{"type":"model_change","provider":"p","modelId":"m"}\n',
      '{"type":"thinking_level_change","thinkingLevel":"high"}\n',
      '{"type":"compaction"}\n',
      '{"type":"message","timestamp":"t","message":{"role":"toolResult","content":[{"type":"text","text":"hi\\n"}]}}\n',
      '{"type":"message","timestamp":"t",\n',
      '{"type":"message","timestamp":"t2","message":{"role":"user","content":[{"type":"text","text":"after"}]}}\n',
    ]);
    const { entries } = readTranscript(stateDir, "s1");
    expect(entries).toEqual([{ role: "user", at: "t2", text: "after" }]);
  });

  it("summarises multi-line tool arguments as one clamped line", () => {
    writeSession([
      JSON.stringify({
        type: "message",
        timestamp: "t",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "a.ts", text: "line1\nline2" } }],
        },
      }) + "\n",
    ]);
    const [entry] = readTranscript(stateDir, "s1").entries;
    expect(entry?.role).toBe("tool");
    expect(entry?.text).toBe('write({"path":"a.ts","text":"line1\\nline2"})');
  });

  it("clamps long tool arguments", () => {
    writeSession([
      JSON.stringify({
        type: "message",
        timestamp: "t",
        message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "x".repeat(300) } }] },
      }) + "\n",
    ]);
    const [entry] = readTranscript(stateDir, "s1").entries;
    expect(entry?.text.length).toBeLessThan(130);
    expect(entry?.text).toContain("…");
  });

  it("picks the newest session file in the pinned dir", () => {
    writeSession(['{"type":"message","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"old"}]}}'], "old.jsonl");
    writeSession(['{"type":"message","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"new"}]}}'], "new.jsonl");
    utimesSync(join(stateDir, "pi-sessions", "s1", "new.jsonl"), new Date(), new Date(Date.now() + 5000));
    expect(readTranscript(stateDir, "s1").entries.map((e) => e.text)).toEqual(["new"]);
  });
});