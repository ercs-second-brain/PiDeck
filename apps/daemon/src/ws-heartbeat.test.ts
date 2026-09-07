/**
 * Unit tests for the WS keepalive (issue #100): a healthy socket gets pings
 * and stays open; a socket that misses its pong is terminated so the normal
 * close cleanup (hub client removal, bridge detach) can run.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { monitorWebSocket } from "./ws-heartbeat.js";

/** Minimal ws-like double: only the surface monitorWebSocket touches. */
class FakeHeartSocket extends EventEmitter {
  static OPEN = 1;
  readyState = FakeHeartSocket.OPEN;
  pings = 0;
  terminated = false;

  ping(): void {
    this.pings += 1;
  }

  terminate(): void {
    this.terminated = true;
  }

  pong(): void {
    this.emit("pong");
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("monitorWebSocket", () => {
  it("pings healthy sockets on the interval and keeps them open", () => {
    const socket = new FakeHeartSocket();
    monitorWebSocket(socket, { intervalMs: 1000 });
    vi.advanceTimersByTime(1000);
    socket.pong();
    vi.advanceTimersByTime(1000);
    socket.pong();
    vi.advanceTimersByTime(1500);
    expect(socket.pings).toBe(3);
    expect(socket.terminated).toBe(false);
    socket.emit("close"); // stop path
  });

  it("answers pongs by staying alive", () => {
    const socket = new FakeHeartSocket();
    monitorWebSocket(socket, { intervalMs: 1000 });
    vi.advanceTimersByTime(1000);
    socket.pong();
    vi.advanceTimersByTime(1000);
    socket.pong();
    vi.advanceTimersByTime(1000);
    expect(socket.pings).toBe(3);
    expect(socket.terminated).toBe(false);
    socket.emit("close");
  });

  it("terminates a socket that misses its pong", () => {
    const socket = new FakeHeartSocket();
    monitorWebSocket(socket, { intervalMs: 1000 });
    vi.advanceTimersByTime(1000); // ping #1 sent, no pong
    vi.advanceTimersByTime(1000); // missed pong → terminate
    expect(socket.terminated).toBe(true);
  });

  it("stops cleanly when the socket closes or stop is called", () => {
    const socket = new FakeHeartSocket();
    const stop = monitorWebSocket(socket, { intervalMs: 1000 });
    stop();
    vi.advanceTimersByTime(5000);
    expect(socket.pings).toBe(0);

    const other = new FakeHeartSocket();
    monitorWebSocket(other, { intervalMs: 1000 });
    other.emit("close");
    vi.advanceTimersByTime(5000);
    expect(other.pings).toBe(0);
  });

  it("is a no-op with the heartbeat disabled (intervalMs 0)", () => {
    const socket = new FakeHeartSocket();
    monitorWebSocket(socket, { intervalMs: 0 });
    vi.advanceTimersByTime(60_000);
    expect(socket.pings).toBe(0);
    expect(socket.terminated).toBe(false);
  });
});
