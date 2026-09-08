/**
 * Integration tests for `Tmux.sendKeys` against a real tmux server + a real
 * pty (issue #115).
 *
 * The fake-tmux unit tests cover the wire format; these prove the *end-to-end*
 * delivery property the bug report is about: every byte of a message —
 * dash-prefixed, multi-line, multi-chunk — reaches the pane's input in order,
 * and the submitting Enter arrives after the payload. The pane runs a
 * raw-mode Node recorder so the tty line discipline cannot rewrite control
 * bytes (a plain `cat` would translate CR and swallow specials).
 *
 * Skipped gracefully when tmux is unavailable; runs on a private socket.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Tmux } from "./tmux.js";

const SOCKET = `agentskiss-send-test-${process.pid}`;
const tmuxAvailable = await Tmux.isAvailable();

let stateDir = "";
let logFile = "";
let tmux: Tmux;

/** Raw-mode recorder: appends every stdin byte to the log untouched. */
function recorderScript(log: string): string {
  return [
    "const fs=require('fs');",
    `const log=${JSON.stringify(log)};`,
    "process.stdin.setRawMode(true);",
    "process.stdin.resume();",
    "process.stdin.on('data',(d)=>fs.appendFileSync(log,d));",
  ].join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLog(): Promise<Buffer> {
  try {
    return readFileSync(logFile);
  } catch {
    return Buffer.alloc(0);
  }
}

/** Waits until the recorder log holds at least `minBytes` (or times out). */
async function waitForBytes(minBytes: number): Promise<Buffer> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const buf = await readLog();
    if (buf.length >= minBytes || Date.now() > deadline) return buf;
    await sleep(50);
  }
}

/**
 * Sends a message via the fixed path and asserts the pane's input receives
 * exactly the expected wire bytes followed by the submitting CR. `paste`
 * mirrors `Tmux.sendKeys`: payloads with control characters are wrapped in
 * bracketed-paste markers, plain ones are not.
 */
async function sendAndExpect(
  message: string,
  options: { paste?: boolean } = {},
): Promise<void> {
  const offset = (await readLog()).length;
  await tmux.sendKeys("send-it-recorder", message, { enter: true });
  const wire = options.paste === false ? message : wireForm(message);
  const expected = Buffer.concat([Buffer.from(wire, "utf8"), Buffer.from("\r")]);
  const received = await waitForBytes(offset + expected.length);
  expect(received.subarray(offset, offset + expected.length).equals(expected)).toBe(true);
}

beforeAll(async () => {
  if (!tmuxAvailable) return;
  stateDir = mkdtempSync(path.join(tmpdir(), "agentskiss-send-it-"));
  logFile = path.join(stateDir, "rec.log");
  const script = path.join(stateDir, "recorder.js");
  writeFileSync(script, recorderScript(logFile));
  tmux = new Tmux({ socketName: SOCKET, sendEnterDelayMs: 50 });
  await tmux.newSession("send-it-recorder", {
    cwd: stateDir,
    command: [process.execPath, script],
  });
  await sleep(400);
});

afterAll(async () => {
  if (!tmuxAvailable) return;
  try {
    await tmux.run(["kill-server"]);
  } catch {
    // server may already be gone
  }
});

describe.skipIf(!tmuxAvailable)("Tmux.sendKeys against a real tmux server (issue #115)", () => {
  it("delivers a trailing-newline message and submits with one clean Enter (issue #123)", async () => {
    // Orchestrator messages end with \n; the wire must carry the paste
    // WITHOUT it (the editor would insert it as literal text) and rely on
    // the explicit Enter for submission.
    await sendAndExpect("multi-line with trailing newline\nsecond line\n");
  });

  it("delivers a dash-prefixed multi-line message fully and submits it", async () => {
    await sendAndExpect(
      "- CI is red on PR #12:\n  - typecheck fails in packages/shared\n  - fix and push",
    );
  });

  it("delivers a multi-chunk payload byte-exactly (past tmux's command buffer)", { timeout: 30_000 }, async () => {
    // tmux rejects a >16KB `send-keys -l` argument with `command too long`;
    // the chunked hex path must reassemble the payload exactly.
    const longLine = "point: the quick brown fox jumps over the lazy dog 0123456789\n";
    await sendAndExpect(longLine.repeat(120)); // ~7KB — more than one invocation
  });

  it("keeps rapid concurrent sends intact (no interleaved chunks)", { timeout: 30_000 }, async () => {
    const messages = [
      "first message: run the failing suite\nand report back",
      "second message: also check the lint gate",
      "third: -1 regression on the board, please triage",
    ];
    const offset = (await readLog()).length;
    await Promise.all(
      messages.map((m) => tmux.sendKeys("send-it-recorder", m, { enter: true })),
    );
    // Each message must arrive as one contiguous, correctly-terminated run —
    // chunk interleaving would split them. Multi-line messages travel inside
    // bracketed-paste markers; single-line ones do not.
    const received = await waitForBytes(
      offset +
        messages.reduce(
          (sum, m) =>
            sum +
            Buffer.byteLength(wireForm(m) + "\r", "utf8"),
          0,
        ),
    );
    const fresh = received.subarray(offset);
    for (const m of messages) {
      const unit = Buffer.from(wireForm(m) + "\r", "utf8");
      expect(fresh.includes(unit)).toBe(true);
    }
  });

  it("delivers a 100KB payload byte-exactly (the size that killed `send-keys -l`)", { timeout: 60_000 }, async () => {
    await sendAndExpect("x".repeat(100_000), { paste: false });
  });
});

/** The bytes `sendKeys` should put on the pane's input for `message`. */
function wireForm(message: string): string {
  const body = message.replace(/[\r\n]+$/, "");
  return /[\x00-\x1f\x7f]/.test(body) ? `\x1b[200~${body}\x1b[201~` : body;
}
