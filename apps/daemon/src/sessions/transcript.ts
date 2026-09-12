/**
 * Reads a session's pi transcript — the JSONL pi appends under
 * `<stateDir>/pi-sessions/<sessionId>/` — as plain conversation entries:
 * role (user / assistant / tool), timestamp, and text. The newest JSONL in
 * the pinned session dir is the live one. Header, model-change, compaction,
 * and tool-result lines carry no conversation text and are skipped; a
 * tool-call block becomes a `tool` entry summarised as
 * `name(one-line arguments)`; torn or foreign lines are ignored, never
 * fatal.
 */

import { readFileSync } from "node:fs";
import {
  SessionTranscriptSchema,
  type SessionTranscript,
  type TranscriptEntry,
} from "@pideck/shared";
import { piTranscriptPath } from "../reconciler/trace.js";

const MAX_ARGS_CHARS = 120;

export function readTranscript(stateDir: string, sessionId: string): SessionTranscript {
  const file = piTranscriptPath(stateDir, sessionId);
  if (file === null) return { entries: [] };
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    return { entries: [] };
  }
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event["type"] !== "message") continue;
    const message = event["message"];
    if (message === null || typeof message !== "object") continue;
    const role = (message as Record<string, unknown>)["role"];
    if (role !== "user" && role !== "assistant") continue;
    const at = typeof event["timestamp"] === "string" ? event["timestamp"] : null;
    const content = (message as Record<string, unknown>)["content"];
    const blocks = Array.isArray(content) ? (content as unknown[]) : [content];
    const text = blocks
      .filter(isTextBlock)
      .map((block) => block.text)
      .join("\n");
    if (text !== "") entries.push({ role, at, text });
    if (role === "assistant") {
      for (const block of blocks) {
        if (!isToolCallBlock(block)) continue;
        entries.push({ role: "tool", at, text: toolCallSummary(block.name, block.arguments) });
      }
    }
  }
  return SessionTranscriptSchema.parse({ entries });
}

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolCallBlock {
  type: "toolCall";
  name: string;
  arguments: unknown;
}

function isTextBlock(block: unknown): block is TextBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as Record<string, unknown>)["type"] === "text" &&
    typeof (block as Record<string, unknown>)["text"] === "string"
  );
}

function isToolCallBlock(block: unknown): block is ToolCallBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as Record<string, unknown>)["type"] === "toolCall" &&
    typeof (block as Record<string, unknown>)["name"] === "string"
  );
}

/** Collapses the call's arguments to one clampable line: `name(args)`. */
function toolCallSummary(name: string, args: unknown): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(args) ?? "";
  } catch {
    rendered = "";
  }
  rendered = rendered.replace(/\s+/g, " ").trim();
  if (rendered.length > MAX_ARGS_CHARS) rendered = `${rendered.slice(0, MAX_ARGS_CHARS - 1)}…`;
  return `${name}(${rendered})`;
}