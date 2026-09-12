/**
 * In-memory WebSocket fake shared by the web test suites: records every
 * sent frame, tracks instance order, and gives tests helpers to open the
 * socket, deliver server frames, or drop the connection the way a real
 * close would.
 */

export type FakeFrame = Record<string, unknown>;

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static reset() {
    FakeWebSocket.instances = [];
  }

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "" });
  }

  /** Test helper: the handshake completes. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Test helper: the daemon sends a frame (or arbitrary noise). */
  serverSends(frame: FakeFrame | string) {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }

  /** Test helper: the connection drops unexpectedly. */
  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "" });
  }

  get lastFrame(): FakeFrame {
    const raw = this.sent[this.sent.length - 1];
    return JSON.parse(raw ?? "{}") as FakeFrame;
  }

  get frames(): FakeFrame[] {
    return this.sent.map((raw) => JSON.parse(raw) as FakeFrame);
  }
}