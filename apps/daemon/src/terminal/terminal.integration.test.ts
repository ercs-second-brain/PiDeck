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
import { afterAll, beforeAll, describe, it } from "vitest";
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

describe.skipIf(!tmuxAvailable)("terminal bridge against a real tmux server", () => {
  it(
    "streams output, forwards input, resizes, and reports exit over WebSocket",
    async () => {
      // A session whose pane echoes everything typed (classic `cat`).
      await tmux.newSession("agentskiss-term-it-1", {
        cwd: stateDir,
        command: ["bash", "-c", "exec cat"],
      });
      const session = registry.createSession({
        projectId: "term-it",
        role: "orchestrator",
        tmuxSession: "agentskiss-term-it-1",
        workerId: null,
      });

      const client = await connect();
      client.attach(session.id);
      await pollUntil(async () =>
        (await client.events()).some((event) => event.type === "terminal.attached"),
      );
      await pollUntil(async () =>
        (await client.events()).some((event) => event.type === "terminal.data"),
      );

      // Input reaches the pane; `cat` echoes it back into a data frame.
      client.sendInput("bridge echo OK\r");
      await pollUntil(async () => {
        const data = (await client.events())
          .filter((event) => event.type === "terminal.data")
          .map((event) => (event.type === "terminal.data" ? event.data : ""))
          .join("");
        return data.includes("bridge echo OK");
      });

      // Resize propagates to the tmux window.
      client.resize(110, 33);
      await pollUntil(async () => {
        const size = await tmux.run([
          "display-message",
          "-p",
          "-t",
          "agentskiss-term-it-1:",
          "#{window_width}x#{window_height}",
        ]);
        return size.stdout.trim() === "110x33";
      });

      // Killing the tmux session surfaces as terminal.exited.
      await tmux.killSession("agentskiss-term-it-1");
      await pollUntil(async () =>
        (await client.events()).some((event) => event.type === "terminal.exited"),
      );

      client.close();
    },
    20_000,
  );

  it(
    "reconnect replays the pane scrollback after a drop",
    async () => {
      await tmux.newSession("agentskiss-term-it-2", {
        cwd: stateDir,
        command: ["bash", "-c", 'echo MARKER-ONE; exec cat'],
      });
      const session = registry.createSession({
        projectId: "term-it",
        role: "worker",
        tmuxSession: "agentskiss-term-it-2",
        workerId: null,
      });

      const first = await connect();
      first.attach(session.id);
      await pollUntil(async () =>
        (await first.events()).some((event) => event.type === "terminal.attached"),
      );
      await pollUntil(async () => {
        const joined = (await first.events())
          .filter((event) => event.type === "terminal.data")
          .map((event) => (event.type === "terminal.data" ? event.data : ""))
          .join("");
        return joined.includes("MARKER-ONE");
      });
      first.close();

      // "Network drop" → new socket → reconnect: replay includes the marker.
      const second = await connect();
      second.attach(session.id);
      await pollUntil(async () =>
        (await second.events()).some(
          (event) => event.type === "terminal.attached",
        ),
      );
      await pollUntil(async () => {
        const joined = (await second.events())
          .filter((event) => event.type === "terminal.data")
          .map((event) => (event.type === "terminal.data" ? event.data : ""))
          .join("");
        return joined.includes("MARKER-ONE");
      });
      second.close();
    },
    20_000,
  );
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
