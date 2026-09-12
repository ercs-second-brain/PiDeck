// @vitest-environment jsdom

/**
 * Tests for the typed REST/WS client: `api()` speaks the shared endpoint
 * table (path params, JSON body, schema-validated response, ApiError on
 * failure) and `watchSessions()` dispatches `sessions.changed` over one /ws
 * socket and reconnects after an unexpected close.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, watchSessions, type WebSocketFactory } from "./api";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset() {
    FakeWebSocket.instances = [];
  }

  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }

  emit(message: unknown) {
    this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
  }
}

const Impl = FakeWebSocket as unknown as WebSocketFactory;

afterEach(() => {
  FakeWebSocket.reset();
  vi.restoreAllMocks();
});

describe("api", () => {
  it("fetches the endpoint path with params and validates the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: "1.0", stateDir: "/s", pollIntervalSeconds: 30, piReady: true, ghReady: true, github: { throttledUntil: null, lastError: null } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const status = await api("status");
    expect(status.version).toBe("1.0");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/status");
  });

  it("sends the body as JSON for mutating endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ persona: "worker", prompt: "p", edited: false }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await api("promptPut", { persona: "worker" }, { prompt: "p" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/prompts/worker");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ prompt: "p" }));
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("throws ApiError with the status on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    await expect(api("status")).rejects.toBeInstanceOf(ApiError);
    await expect(api("status")).rejects.toMatchObject({ status: 500 });
  });

  it("throws ApiError when the response does not match the schema", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    await expect(api("status")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("watchSessions", () => {
  it("opens /ws on the same origin and dispatches sessions.changed", () => {
    const received: number[][] = [];
    const stop = watchSessions(
      (views) => received.push(views.map((view) => view.session.issueNumber ?? -1)),
      "ws://daemon/ws",
      Impl,
    );
    const ws = FakeWebSocket.instances[0];
    expect(ws?.url).toBe("ws://daemon/ws");
    ws?.onopen?.();
    ws?.emit({
      type: "sessions.changed",
      sessions: [
        {
          session: {
            id: "s1",
            persona: "worker",
            projectId: "p1",
            issueNumber: 42,
            prNumber: undefined,
            tmuxSession: "t",
            spawnedAt: "2026-01-01T00:00:00Z",
            model: null,
            lastPromptedHeadSha: null,
            lastDeliveredIssueCommentId: null,
            lastDeliveredPrCommentId: null,
            lastDeliveredReviewId: null,
            fixAttempts: 0,
            lastActivityAt: null,
          },
          state: "working",
          status: "on it",
          parentSessionId: null,
          title: "Add rate limiting",
        },
      ],
    });
    // terminal.data frames and junk are ignored; sessions.changed dispatched.
    ws?.emit({ type: "terminal.data", sessionId: "s1", data: "hi" });
    ws?.emit("not json");
    expect(received).toEqual([[42]]);
    stop();
  });

  it("reconnects with backoff after an unexpected close and unsubscribes cleanly", () => {
    vi.useFakeTimers();
    try {
      const stop = watchSessions(() => {}, "ws://daemon/ws", Impl);
      const first = FakeWebSocket.instances[0];
      first?.onopen?.();
      first?.onclose?.();
      vi.advanceTimersByTime(1500);
      expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
      stop();
      const before = FakeWebSocket.instances.length;
      FakeWebSocket.instances[before - 1]?.onclose?.();
      vi.advanceTimersByTime(30_000);
      expect(FakeWebSocket.instances.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
