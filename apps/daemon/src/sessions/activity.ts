/**
 * Liveness probe: is a session's pi agent mid-turn right now?
 *
 * Every PiDeck session pins its pi JSONL at
 * `<stateDir>/pi-sessions/<sessionId>/`; the newest `.jsonl` there is the
 * live one. An agent turn writes assistant events with `stopReason:
 * "toolUse"` while it still has work to do and `toolResult` events as its
 * tools finish, and ends with a `stopReason: "stop"` (or aborted/error)
 * assistant event. The session is therefore active when the newest message
 * event in that file is an in-flight assistant turn or a tool result, and
 * that event is younger than {@link ACTIVE_WINDOW_MS} — judged from the
 * event's own timestamp, falling back to the file mtime. A completed turn,
 * a user prompt waiting to be picked up, and silence all read as idle; the
 * agent never self-reports.
 *
 * Views are recomputed on every WS push (the hub re-evaluates its snapshot
 * every couple of seconds), so the probe reads only the file's last few
 * kilobytes and never the whole transcript.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { piTranscriptPath } from "../reconciler/trace.js";

/** A turn whose newest event is older than this is idle, whatever it says. */
export const ACTIVE_WINDOW_MS = 60_000;

const TAIL_BYTES = 8192;

/** True when the session's newest pi event is a fresh in-flight turn. */
export function sessionActive(stateDir: string, sessionId: string, now = Date.now()): boolean {
  const file = piTranscriptPath(stateDir, sessionId);
  if (file === null) return false;
  const event = newestMessageEvent(file);
  if (event === null) return false;
  if (now - event.at > ACTIVE_WINDOW_MS) return false;
  if (event.role === "toolResult") return true;
  return event.role === "assistant" && event.stopReason === "toolUse";
}

interface NewestMessageEvent {
  role: string;
  stopReason: string | null;
  /** Event timestamp in ms, else the file's mtime. */
  at: number;
}

/** Scans the tail of the JSONL backwards for the newest parseable message event. */
function newestMessageEvent(file: string): NewestMessageEvent | null {
  const tail = readTail(file);
  if (tail === null) return null;
  for (const line of tail.text.split("\n").reverse()) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // torn or foreign line — the previous one is still good
    }
    if (event["type"] !== "message") continue;
    const message = event["message"];
    if (message === null || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    const role = record["role"];
    if (typeof role !== "string") continue;
    return {
      role,
      stopReason: typeof record["stopReason"] === "string" ? record["stopReason"] : null,
      at: timestampMs(event["timestamp"]) ?? numericMs(record["timestamp"]) ?? tail.mtimeMs,
    };
  }
  return null;
}

/** The file's last {@link TAIL_BYTES} bytes and its mtime, or null when unreadable. */
function readTail(file: string): { text: string; mtimeMs: number } | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const stats = fstatSync(fd);
    const start = Math.max(0, stats.size - TAIL_BYTES);
    const buffer = Buffer.alloc(stats.size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return { text: buffer.toString("utf8"), mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function numericMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}