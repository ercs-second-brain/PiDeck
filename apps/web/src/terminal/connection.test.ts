/**
 * Tests for the browser-side terminal connection: WebSocket lifecycle for one
 * session, speaking the terminal message family from `@pideck/shared`.
 * Pure node — the WebSocket is a fake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "../test-support/websocket";
import { TerminalConnection, type WebSocketConstructor } from "./connection";

const Impl = FakeWebSocket as unknown as WebSocketConstructor;

function makeConnection() {
  const onData = vi.fn();
  const onReplay = vi.fn();
  const onStatus = vi.fn();
  const connection = new TerminalConnection({ onData, onReplay, onStatus }, "ws://test/ws", Impl);
  return { connection, onData, onReplay, onStatus };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalConnection", () => {
  it("opens a socket, replays, and sends terminal.attach with the pane size", () => {
    const { connection, onReplay, onStatus } = makeConnection();
    connection.attach("s1", 101, 30);
    expect(onStatus).toHaveBeenCalledWith("connecting");
    const ws = FakeWebSocket.instances[0];
    expect(ws?.url).toBe("ws://test/ws");
    ws?.open();
    expect(onReplay).toHaveBeenCalledOnce();
    expect(ws?.lastFrame).toEqual({ type: "terminal.attach", sessionId: "s1", cols: 101, rows: 30 });
  });

  it("streams terminal.data frames and ignores daemon-wide events and noise", () => {
    const { connection, onData } = makeConnection();
    connection.attach("s1", 80, 24);
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    ws?.serverSends({ type: "terminal.data", sessionId: "s1", data: "hello " });
    ws?.serverSends({ type: "sessions.changed", sessions: [] });
    ws?.serverSends("not json");
    ws?.serverSends({ type: "terminal.data", sessionId: "s1", data: "world" });
    expect(onData).toHaveBeenCalledTimes(2);
    expect(onData).toHaveBeenNthCalledWith(1, "hello ");
    expect(onData).toHaveBeenNthCalledWith(2, "world");
  });

  it("forwards input and resize frames while attached", () => {
    const { connection } = makeConnection();
    connection.attach("s1", 80, 24);
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    connection.sendInput("ls\r");
    connection.resize(120, 40);
    expect(ws?.sent).toEqual([
      JSON.stringify({ type: "terminal.attach", sessionId: "s1", cols: 80, rows: 24 }),
      JSON.stringify({ type: "terminal.data", sessionId: "s1", data: "ls\r" }),
      JSON.stringify({ type: "terminal.resize", sessionId: "s1", cols: 120, rows: 40 }),
    ]);
  });

  it("reconnects with backoff after an unexpected close and re-attaches", () => {
    const { connection, onStatus } = makeConnection();
    connection.attach("s1", 80, 24);
    const first = FakeWebSocket.instances[0];
    first?.open();
    first?.drop();
    expect(onStatus).toHaveBeenLastCalledWith("reconnecting");
    // The backoff is jittered around 500ms for attempt 1.
    vi.advanceTimersByTime(1500);
    const second = FakeWebSocket.instances[1];
    expect(second).toBeDefined();
    second?.open();
    expect(second?.lastFrame).toEqual({ type: "terminal.attach", sessionId: "s1", cols: 80, rows: 24 });
  });

  it("keeps input buffered size-wise: a resize while connecting is adopted on attach", () => {
    const { connection } = makeConnection();
    connection.attach("s1", 80, 24);
    const ws = FakeWebSocket.instances[0];
    connection.resize(132, 43);
    ws?.open();
    expect(ws?.lastFrame).toEqual({ type: "terminal.attach", sessionId: "s1", cols: 132, rows: 43 });
  });

  it("announces terminal.detach and closes cleanly without reconnecting", () => {
    const { connection } = makeConnection();
    connection.attach("s1", 80, 24);
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    connection.detach();
    expect(ws?.lastFrame).toEqual({ type: "terminal.detach", sessionId: "s1" });
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("does not reconnect after detach", () => {
    const { connection } = makeConnection();
    connection.attach("s1", 80, 24);
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    connection.detach();
    // Even a late close event on the detached socket must not reconnect.
    ws?.drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("switching sessions detaches the old one and attaches the new", () => {
    const { connection } = makeConnection();
    connection.attach("s1", 80, 24);
    FakeWebSocket.instances[0]?.open();
    connection.attach("s2", 90, 26);
    expect(FakeWebSocket.instances[0]?.lastFrame).toEqual({ type: "terminal.detach", sessionId: "s1" });
    const ws = FakeWebSocket.instances[1];
    ws?.open();
    expect(ws?.lastFrame).toEqual({ type: "terminal.attach", sessionId: "s2", cols: 90, rows: 26 });
  });

  it("backs off exponentially across attempts", () => {
    const { connection } = makeConnection();
    connection.attach("s1", 80, 24);
    let ws = FakeWebSocket.instances[0];
    ws?.open();
    // Attempt 1: base 500ms (jittered 375–625).
    ws?.drop();
    vi.advanceTimersByTime(375);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(250);
    // Attempt 2: base 1000ms (jittered 750–1250).
    ws = FakeWebSocket.instances[1];
    ws?.open();
    ws?.drop();
    vi.advanceTimersByTime(749);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(501);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });
});