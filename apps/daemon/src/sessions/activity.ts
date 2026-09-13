/**
 * Liveness probe: is a session's pi agent mid-turn right now?
 *
 * Every PiDeck session pins its pi JSONL at
 * `<stateDir>/pi-sessions/<sessionId>/`; the newest `.jsonl` there is the
 * live one. An agent turn writes assistant events with `stopReason:
 * "toolUse"` while it still has work to do and `toolResult` events as its
 * tools finish, and ends with a `stopReason: "stop"` (or aborted/error)
 * assistant event. "Working" is therefore the shape of the transcript, not
 * the age of its last write — a tool call can run for an hour — so the
 * session is active when the newest message event is an in-flight assistant
 * turn or a tool result, however old. A completed turn and a user prompt
 * waiting to be picked up read as idle, as does a dead pane (the caller
 * passes `paneAlive: false`); the agent never self-reports.
 *
 * Views are recomputed on every WS push (the hub re-evaluates its snapshot
 * every couple of seconds), so the probe reads only the file's last few
 * kilobytes and never the whole transcript.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { piTranscriptPath } from "../reconciler/trace.js";

const TAIL_BYTES = 8192;

/** True when the session's newest pi event is an in-flight turn and its pane is alive. */
export function sessionActive(stateDir: string, sessionId: string, paneAlive = true): boolean {
  if (!paneAlive) return false;
  const file = piTranscriptPath(stateDir, sessionId);
  if (file === null) return false;
  const event = newestMessageEvent(file);
  if (event === null) return false;
  return event.role === "toolResult" || (event.role === "assistant" && event.stopReason === "toolUse");
}

interface NewestMessageEvent {
  role: string;
  stopReason: string | null;
}

/** Scans the tail of the JSONL backwards for the newest parseable message event. */
function newestMessageEvent(file: string): NewestMessageEvent | null {
  const text = readTail(file);
  if (text === null) return null;
  for (const line of text.split("\n").reverse()) {
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
    };
  }
  return null;
}

/** The file's last {@link TAIL_BYTES} bytes, or null when unreadable. */
function readTail(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const stats = fstatSync(fd);
    const start = Math.max(0, stats.size - TAIL_BYTES);
    const buffer = Buffer.alloc(stats.size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
