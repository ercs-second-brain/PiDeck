/**
 * Shared harness for the terminal bridge unit tests: fake tmux runner +
 * fake sockets, no real tmux, no real WebSocket (issue #7; extended for
 * #67's streaming/coalescing tests in `bridge-stream.test.ts`).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { terminalServerEventSchema, type TerminalServerEvent } from "@agentskiss/shared";
import { SessionRegistry } from "../../sessions/registry.js";
import { Tmux, type TmuxRunner } from "../../sessions/tmux.js";
import { TerminalBridge, type TerminalBridgeOptions, type TerminalSocket } from "../bridge.js";
import { FakeTmuxRunner } from "../../sessions/testing/fake-tmux.js";

/** Test double for a browser-side WebSocket. */
class FakeSocket implements TerminalSocket {
  readonly sent: string[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;

  private readonly messageCallbacks: Array<(payload: string) => void> = [];
  private readonly closeCallbacks: Array<() => void> = [];

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code?: number, reason?: string): void {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    for (const cb of this.closeCallbacks) cb();
  }

  onMessage(cb: (payload: string) => void): void {
    this.messageCallbacks.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeCallbacks.push(cb);
  }

  /** Simulates the client sending a message. */
  clientSend(payload: string): void {
    for (const cb of this.messageCallbacks) cb(payload);
  }

  /** Parses everything sent so far as server events. */
  events(): TerminalServerEvent[] {
    return this.sent
      .map((payload) => terminalServerEventSchema.parse(JSON.parse(payload)))
      .filter((event) => event.type.startsWith("terminal."));
  }

  dataEvents(): Extract<TerminalServerEvent, { type: "terminal.data" }>[] {
    return this.events().filter(
      (event): event is Extract<TerminalServerEvent, { type: "terminal.data" }> =>
        event.type === "terminal.data",
    );
  }
}

export interface BridgeHarness {
  fake: FakeTmuxRunner;
  tmux: Tmux;
  registry: SessionRegistry;
  bridge: TerminalBridge;
  /** Every socket created via {@link open}; closed by {@link closeAll}. */
  readonly sockets: FakeSocket[];
  open(bridge?: TerminalBridge): FakeSocket;
  send(socket: FakeSocket, message: unknown): void;
  seedSession(options?: SeedOptions): Promise<ReturnType<SessionRegistry["createSession"]>>;
  closeAll(): void;
}

interface SeedOptions {
  projectId?: string;
  role?: "orchestrator" | "worker";
  lines?: string[];
}

export function setupHarness(
  options: TerminalBridgeOptions = {},
  overrides: { tmuxRunner?: TmuxRunner } = {},
): BridgeHarness {
  const dir = mkdtempSync(path.join(tmpdir(), "pideck-bridge-"));
  const fake = new FakeTmuxRunner();
  const tmux = new Tmux({ runner: overrides.tmuxRunner ?? fake.asRunner() });
  const registry = new SessionRegistry(path.join(dir, "sessions.json"));
  const bridge = new TerminalBridge(
    { tmux, registry },
    { activePollMs: 5, idlePollMs: 5, scrollbackLines: 100, ...options },
  );
  const sockets: FakeSocket[] = [];

  return {
    fake,
    tmux,
    registry,
    bridge,
    sockets,
    open(bridgeOverride?: TerminalBridge): FakeSocket {
      const socket = new FakeSocket();
      sockets.push(socket);
      (bridgeOverride ?? bridge).handleOpen(socket);
      return socket;
    },
    send(socket: FakeSocket, message: unknown): void {
      socket.clientSend(JSON.stringify(message));
    },
    async seedSession(seed: SeedOptions = {}) {
      const projectId = seed.projectId ?? "proj";
      const role = seed.role ?? "orchestrator";
      const tmuxName = `pideck-${projectId}-${role}-1`;
      await tmux.newSession(tmuxName);
      const session = registry.createSession({
        projectId,
        role,
        tmuxSession: tmuxName,
        workerId: null,
      });
      if (seed.lines) {
        fake.sessions.get(tmuxName)?.paneLines.push(...seed.lines);
      }
      return session;
    },
    closeAll(): void {
      for (const socket of sockets) socket.close();
    },
  };
}
