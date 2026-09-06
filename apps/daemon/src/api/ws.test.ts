/**
 * WsHub tests: kanban broadcast fan-out, terminal-message redirection to the
 * terminal bridge's `/ws` endpoint, and invalid-message handling — over real
 * sockets.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { KanbanUpdateEvent } from "@agentskiss/shared";

import { WsHub, WS_PATH } from "./ws.js";

let server: Server;
let hub: WsHub;
let wsBase: string;

beforeAll(async () => {
  hub = new WsHub();
  server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  hub.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  wsBase = `ws://127.0.0.1:${port}${WS_PATH}`;
});

afterAll(async () => {
  hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function connect(): Promise<{ ws: WebSocket; messages: unknown[]; open: Promise<void> }> {
  const ws = new WebSocket(wsBase);
  const messages: unknown[] = [];
  const open = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.on("message", (raw: Buffer) => messages.push(JSON.parse(raw.toString("utf8")) as unknown));
  return { ws, messages, open };
}

async function waitFor(messages: unknown[], predicate: (m: unknown) => boolean): Promise<unknown> {
  for (let i = 0; i < 50; i++) {
    const found = messages.find(predicate);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected message not received; got: ${JSON.stringify(messages)}`);
}

describe("WsHub", () => {
  it("broadcasts kanban events to all connected clients", async () => {
    const clientA = await connect();
    const clientB = await connect();
    await Promise.all([clientA.open, clientB.open]);
    expect(hub.clientCount).toBe(2);

    const event: KanbanUpdateEvent = {
      type: "worker.spawned",
      at: "2026-01-01T00:00:00.000Z",
      worker: {
        id: "worker-1",
        projectId: "p",
        sessionId: "sess-1",
        issueNumber: 3,
        prNumber: null,
        status: "spawning",
        statusMessage: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    hub.broadcast(event);

    await waitFor(clientA.messages, (m) => (m as { type?: string }).type === "worker.spawned");
    await waitFor(clientB.messages, (m) => (m as { type?: string }).type === "worker.spawned");
    clientA.ws.close();
    clientB.ws.close();
  });

  it("rejects invalid events rather than sending malformed payloads", () => {
    expect(() =>
      hub.broadcast({
        type: "worker.spawned",
        at: "not-a-date",
        worker: {},
      } as unknown as KanbanUpdateEvent),
    ).toThrow();
  });

  it("points terminal messages at the /ws terminal endpoint", async () => {
    const client = await connect();
    await client.open;
    client.ws.send(JSON.stringify({ type: "terminal.attach", sessionId: "sess-1", cols: 80, rows: 24 }));
    const reply = await waitFor(client.messages, (m) => (m as { error?: string }).error !== undefined);
    expect((reply as { error: string }).error).toContain("/ws");
    client.ws.close();
  });

  it("rejects malformed messages", async () => {
    const client = await connect();
    await client.open;
    client.ws.send("this is not json");
    client.ws.send(JSON.stringify({ type: "terminal.attach", sessionId: "" })); // invalid size/missing fields
    const first = await waitFor(client.messages, (m) => (m as { error?: string }).error !== undefined);
    expect((first as { error: string }).error).toContain("not valid JSON");
    const second = await waitFor(client.messages, (m) => (m as { error?: string }).error !== undefined && (m as { error: string }).error !== (first as { error: string }).error);
    expect((second as { error: string }).error).toContain("unsupported message");
    client.ws.close();
  });

});
