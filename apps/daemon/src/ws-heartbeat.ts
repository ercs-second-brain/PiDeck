/**
 * WebSocket keepalive (issue #100, phase 2): server-side ping/pong heartbeat
 * for every socket the daemon serves (`/api/ws` kanban hub + `/ws` terminal
 * bridge).
 *
 * Without heartbeat traffic, a half-open socket (laptop sleep, NAT timeout,
 * dropped Wi-Fi) never fires `close` on the daemon side: the hub and bridge
 * keep the dead socket in their client sets forever (memory growth), the
 * bridge keeps a pane streamer + pipe-pane stream alive for it, and the
 * browser can sit attached to a zombie connection showing stale state until
 * the OS finally gives up minutes later.
 *
 * The fix is protocol-level pings: every `intervalMs` the daemon pings each
 * socket; browsers and the `ws` client answer pongs automatically. A socket
 * that misses one ping is terminated, which fires `close` through the normal
 * cleanup path (hub client removal, bridge detach → streamer dispose).
 */

import { WebSocket } from "ws";

export interface HeartbeatOptions {
  /** Ping cadence (ms). */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 30_000;

/**
 * Minimal socket surface the heartbeat needs — structurally satisfied by
 * `ws`'s `WebSocket`, and small enough for tests to fake.
 */
export interface HeartbeatSocket {
  readyState: number;
  ping(): void;
  terminate(): void;
  on(event: "pong" | "close", listener: () => void): unknown;
  off(event: "pong" | "close", listener: () => void): unknown;
}

/** Per-socket liveness state shared by the ping timer and the pong listener. */
interface SocketHeartbeat {
  timer: ReturnType<typeof setInterval>;
  alive: boolean;
}

/**
 * Starts the heartbeat for one accepted socket. Returns a stop function
 * (called automatically when the socket closes; safe to call twice).
 */
export function monitorWebSocket(socket: HeartbeatSocket, options: HeartbeatOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (intervalMs <= 0) return () => {};
  const state: SocketHeartbeat = { timer: undefined as never, alive: true };
  state.timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (!state.alive) {
      // Missed pong (or the client never answered the last ping): dead.
      socket.terminate();
      return;
    }
    state.alive = false;
    socket.ping();
  }, intervalMs);
  state.timer.unref();
  const onPong = (): void => {
    state.alive = true;
  };
  const stop = (): void => {
    clearInterval(state.timer);
    socket.off("pong", onPong);
    socket.off("close", stop);
  };
  socket.on("pong", onPong);
  socket.on("close", stop);
  return stop;
}
