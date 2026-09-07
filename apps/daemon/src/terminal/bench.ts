/**
 * Terminal bridge micro-benchmark (issue #67): measures the input and output
 * paths against the fake tmux runner so regressions are caught without
 * needing a real tmux server.
 *
 * Scenarios:
 * - `coalescing` — 300 rapid keystrokes through a client socket: counts
 *   `send-keys` invocations (was: 1 per keystroke), wall time, and the
 *   echo latency distribution (keystroke → pane-visible frame).
 * - `captures` — pane output arriving at a high rate: counts captures per
 *   second and bytes captured per second with the event source active.
 *
 * Run: `pnpm --filter @agentskiss/daemon bench:terminal`
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionRegistry } from "../sessions/registry.js";
import { Tmux } from "../sessions/tmux.js";
import { FakeTmuxRunner } from "../sessions/testing/fake-tmux.js";
import { TerminalBridge, type TerminalBridgeOptions, type TerminalSocket } from "./bridge.js";

interface BenchSocket extends TerminalSocket {
  sent: string[];
  clientSend(payload: string): void;
}

function makeSocket(): BenchSocket {
  const sent: string[] = [];
  let onMessage: (payload: string) => void = () => {};
  return {
    sent,
    send: (payload) => sent.push(payload),
    close: () => {},
    onMessage: (cb) => {
      onMessage = cb;
    },
    onClose: () => {},
    clientSend: (payload) => onMessage(payload),
  };
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

interface SetupResult {
  fake: FakeTmuxRunner;
  bridge: TerminalBridge;
  socket: BenchSocket & { clientSend: (payload: string) => void };
  sessionId: string;
  tmuxName: string;
}

function setup(options: TerminalBridgeOptions = {}): SetupResult {
  const fake = new FakeTmuxRunner();
  const tmux = new Tmux({ runner: fake.asRunner() });
  const dir = mkdtempSync(path.join(tmpdir(), "agentskiss-bench-"));
  const registry = new SessionRegistry(path.join(dir, "sessions.json"));
  const bridge = new TerminalBridge({ tmux, registry }, options);
  const tmuxName = "bench-orchestrator-1";
  void tmux.newSession(tmuxName);
  const session = registry.createSession({
    projectId: "bench",
    role: "orchestrator",
    tmuxSession: tmuxName,
    workerId: null,
  });
  const socket = makeSocket();
  bridge.handleOpen(socket);
  socket.clientSend(
    JSON.stringify({ type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 }),
  );
  return {
    fake,
    bridge,
    socket,
    sessionId: session.id,
    tmuxName,
  };
}

async function waitAttached(env: SetupResult): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (env.socket.sent.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("bench: attach never produced output");
}

async function benchCoalescing(): Promise<void> {
  const env = setup({ activePollMs: 50, idlePollMs: 250, inputFlushMs: 8, inputChunkBytes: 4096 });
  await waitAttached(env);
  env.socket.sent.length = 0;
  const before = env.fake.invocations.filter((inv) => inv.args[0] === "send-keys").length;

  // 300 keystrokes at ~60/s (a fast typist with key repeat): 5ms apart.
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) {
    env.socket.clientSend(
      JSON.stringify({ type: "terminal.data", sessionId: env.sessionId, data: String.fromCharCode(97 + (i % 26)) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const wall = performance.now() - t0;
  const after = env.fake.invocations.filter((inv) => inv.args[0] === "send-keys").length;
  const delivered = env.fake.invocations
    .slice(before)
    .filter((inv) => inv.args[0] === "send-keys")
    .reduce((sum, inv) => sum + (inv.args.length - inv.args.indexOf("-H") - 1), 0);

  // Measure echo latency: time from sending one keystroke until the daemon
  // broadcast a data frame containing the pane's echo.
  const echo = await measureEchoLatency(env);
  console.log("─".repeat(64));
  console.log("coalescing: 300 keystrokes at ~200/s");
  console.log(`  send-keys invocations:      ${after - before}  (legacy design: 300)`);
  console.log(`  keystrokes delivered:      ${delivered} (expect 300)`);
  console.log(`  wall time:                  ${Math.round(wall)} ms`);
  console.log(`  echo latency p50/p95/max:   ${echo.p50.toFixed(1)} / ${echo.p95.toFixed(1)} / ${echo.max.toFixed(1)} ms`);
}

/** Sends one marked keystroke and times until a matching output frame. */
async function measureEchoLatency(
  env: SetupResult,
): Promise<{ p50: number; p95: number; max: number }> {
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const marker = `ECHO${i}`;
    const framesBefore = env.socket.sent.length;
    const linesBefore = env.fake.sessions.get(env.tmuxName)?.paneLines.length ?? 0;
    const t0 = performance.now();
    for (const ch of marker) {
      env.socket.clientSend(
        JSON.stringify({ type: "terminal.data", sessionId: env.sessionId, data: ch }),
      );
    }
    // The echo lands in the pane (via the coalesced send-keys), and the next
    // broadcast frame is what a browser would render.
    const deadline = t0 + 300;
    for (;;) {
      const lines = env.fake.sessions.get(env.tmuxName)?.paneLines.length ?? 0;
      const gotFrame = env.socket.sent.length > framesBefore;
      if (lines > linesBefore && gotFrame) break;
      if (performance.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    samples.push(performance.now() - t0);
  }
  return { p50: percentile(samples, 50), p95: percentile(samples, 95), max: Math.max(...samples, 0) };
}

async function benchCaptures(): Promise<void> {
  const env = setup({ activePollMs: 50, idlePollMs: 250, streamPollMs: 500 });
  await waitAttached(env);
  env.socket.sent.length = 0;
  const before = env.fake.invocations.filter((inv) => inv.args[0] === "capture-pane").length;

  // Output arriving at 200 writes/s for 1 second (a chatty build log).
  const durationMs = 1000;
  const writes = 200;
  const t0 = performance.now();
  for (let i = 0; i < writes; i++) {
    env.fake.notifyOutput(env.tmuxName, `build line ${i}: compiling module ${i}\n`);
    if (i % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // Let the stream drain.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = env.fake.invocations.filter((inv) => inv.args[0] === "capture-pane").length;

  // Screen-only capture volume: last capture's byte size (pane screen is 24 rows).
  let bytesPerCapture = 0;
  const lastCapture = [...env.fake.invocations].reverse().find((inv) => inv.args[0] === "capture-pane");
  if (lastCapture) {
    const sIdx = lastCapture.args.indexOf("-S");
    const bound = Number(lastCapture.args[sIdx + 1]);
    const lines = (env.fake.sessions.get(env.tmuxName)?.paneLines ?? []).slice(-bound);
    bytesPerCapture = lines.join("\n").length;
  }

  console.log("─".repeat(64));
  console.log(`captures: ${writes} pane writes in ${durationMs} ms`);
  console.log(`  capture invocations:        ${after - before} over ${(performance.now() - t0).toFixed(0)} ms`);
  console.log(`  bytes per capture:          ~${bytesPerCapture} B (screen-only; legacy: ~10 KB full scrollback)`);
}

await benchCoalescing();
await benchCaptures();
console.log("─".repeat(64));
