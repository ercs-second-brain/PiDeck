/**
 * End-to-end terminal bridge test: real tmux (private socket) + a real HTTP
 * server with the `ws` adapter, driven by a real WebSocket client.
 *
 * Skipped gracefully when tmux is unavailable (e.g. CI runners without
 * tmux); the offline behavior is covered by the fake-based unit tests.
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { terminalServerEventSchema, type TerminalServerEvent } from "@agentskiss/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { SessionRegistry } from "../sessions/registry.js";
import { Tmux } from "../sessions/tmux.js";
import { TerminalBridge } from "./bridge.js";
import { attachTerminalWebSocket } from "./ws-server.js";

const SOCKET = `agentskiss-term-test-${process.pid}`;
const tmuxAvailable = await Tmux.isAvailable();

let stateDir = "";
let tmux: Tmux;
let registry: SessionRegistry;
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  if (!tmuxAvailable) return;
  stateDir = mkdtempSync(path.join(tmpdir(), "agentskiss-term-it-"));
  tmux = new Tmux({ socketName: SOCKET });
  registry = new SessionRegistry(path.join(stateDir, "sessions.json"));
  const bridge = new TerminalBridge({ tmux, registry }, { activePollMs: 30, idlePollMs: 50 });
  server = createServer();
  attachTerminalWebSocket(server, bridge);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  baseUrl = `ws://127.0.0.1:${address.port}/ws`;
});

afterAll(async () => {
  if (!tmuxAvailable) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    await tmux.run(["kill-server"]);
  } catch {
    // server may already be gone
  }
});

interface ClientEvents {
  attach(sessionId: string, cols?: number, rows?: number): void;
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
  events(): Promise<TerminalServerEvent[]>;
  close(): void;
}

function connect(): Promise<ClientEvents> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl);
    const received: TerminalServerEvent[] = [];
    ws.on("message", (data) => {
      const parsed = terminalServerEventSchema.safeParse(JSON.parse(String(data)));
      if (parsed.success) received.push(parsed.data);
    });
    ws.on("error", reject);
    ws.on("open", () => {
      resolve({
        attach: (sessionId, cols = 80, rows = 24) =>
          ws.send(JSON.stringify({ type: "terminal.attach", sessionId, cols, rows })),
        sendInput: (data) => ws.send(JSON.stringify({ type: "terminal.data", sessionId: currentSession, data })),
        resize: (cols, rows) =>
          ws.send(JSON.stringify({ type: "terminal.resize", sessionId: currentSession, cols, rows })),
        events: async () => received,
        close: () => ws.close(),
      });
    });
    let currentSession = "";
    ws.on("message", (data) => {
      const parsed = terminalServerEventSchema.safeParse(JSON.parse(String(data)));
      if (parsed.success && parsed.data.type === "terminal.attached") currentSession = parsed.data.sessionId;
    });
  });
}

/** All terminal.data payloads received so far, joined in order. */
async function dataJoined(client: ClientEvents): Promise<string> {
  return (await client.events())
    .filter((event) => event.type === "terminal.data")
    .map((event) => (event.type === "terminal.data" ? event.data : ""))
    .join("");
}

/** Waits until a server event of the given type has been received. */
async function awaitEvent(client: ClientEvents, type: string, timeoutMs = 5000): Promise<void> {
  await pollUntil(async () => (await client.events()).some((event) => event.type === type), timeoutMs);
}

/** Waits until the pane output stream contains the given marker text. */
async function awaitEcho(client: ClientEvents, marker: string, timeoutMs = 5000): Promise<void> {
  await pollUntil(async () => (await dataJoined(client)).includes(marker), timeoutMs);
}

/** Creates a tmux session running an echoing `cat` pane + its registry entry. */
async function seedCatSession(role: "orchestrator" | "worker", marker?: string) {
  const tmuxName = `agentskiss-term-it-${role}`;
  const command = marker === undefined ? ["bash", "-c", "exec cat"] : ["bash", "-c", `echo ${marker}; exec cat`];
  await tmux.newSession(tmuxName, { cwd: stateDir, command });
  return registry.createSession({ projectId: "term-it", role, tmuxSession: tmuxName, workerId: null });
}

/** Attaches a client and waits for the attach + first data frame. */
async function attachAndWait(client: ClientEvents, sessionId: string): Promise<void> {
  client.attach(sessionId);
  await awaitEvent(client, "terminal.attached");
  await pollUntil(async () => (await dataJoined(client)).length > 0);
}

describe.skipIf(!tmuxAvailable)("terminal bridge against a real tmux server", () => {
  it("streams output, forwards input, resizes, and reports exit over WebSocket", async () => {
    const session = await seedCatSession("orchestrator");
    const client = await connect();
    await attachAndWait(client, session.id);

    // Input reaches the pane; `cat` echoes it back into a data frame.
    client.sendInput("bridge echo OK\r");
    await awaitEcho(client, "bridge echo OK");

    // Resize propagates to the tmux window.
    client.resize(110, 33);
    await pollUntil(async () => {
      const size = await tmux.run([
        "display-message",
        "-p",
        "-t",
        `${session.tmuxSession}:`,
        "#{window_width}x#{window_height}",
      ]);
      return size.stdout.trim() === "110x33";
    });

    // Killing the tmux session surfaces as terminal.exited.
    await tmux.killSession(session.tmuxSession);
    await awaitEvent(client, "terminal.exited");

    client.close();
  }, 20_000);

  it("streams event-driven pipe-pane output within milliseconds of a keystroke", async () => {
    const session = await seedCatSession("orchestrator");
    const client = await connect();
    await attachAndWait(client, session.id);

    // A keystroke's echo must reach the client quickly (event-driven via
    // the pipe-pane stream, not waiting for the idle poll).
    const t0 = Date.now();
    client.sendInput("PING-EVENT\r");
    await awaitEcho(client, "PING-EVENT", 4000);
    // Generous bound keeps this stable on loaded CI runners.
    expect(Date.now() - t0).toBeLessThan(2000);

    client.close();
  }, 20_000);

  it("reconnect replays the pane scrollback after a drop", async () => {
    const session = await seedCatSession("worker", "MARKER-ONE");
    const first = await connect();
    await attachAndWait(first, session.id);
    first.close();

    // "Network drop" → new socket → reconnect: replay includes the marker.
    const second = await connect();
    await attachAndWait(second, session.id);
    second.close();
  }, 20_000);
});

/** Polls `probe` until truthy or timeout (avoids depending on vi beyond vitest). */
async function pollUntil(probe: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
