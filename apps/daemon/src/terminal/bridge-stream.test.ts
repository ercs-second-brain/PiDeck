/**
 * Streaming and input-path tests for the terminal bridge (issue #67):
 * input coalescing, screen-only captures, and the event-driven pipe-pane
 * output source. Shares the fake-tmux harness with `bridge.test.ts`.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupHarness, type BridgeHarness } from "./testing/bridge-harness.js";

let env: BridgeHarness;

beforeEach(() => {
  env = setupHarness();
});

afterEach(() => {
  env.closeAll();
});

describe("TerminalBridge: input coalescing", () => {
  it("forwards input to the pane as hex send-keys", async () => {
    const session = await env.seedSession();
    const socket = env.open();
    env.send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));

    env.send(socket, { type: "terminal.data", sessionId: session.id, data: "echo hi\r" });
    const pane = env.fake.sessions.get(session.tmuxSession);
    await vi.waitFor(() => expect(pane?.paneLines.at(-1)).toBe("echo hi\r"));
  });

  it("coalesces a keystroke burst into a single send-keys invocation", async () => {
    const session = await env.seedSession();
    const socket = env.open();
    env.send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));

    const before = env.fake.invocations.filter((inv) => inv.args[0] === "send-keys").length;
    for (const key of ["h", "e", "l", "l", "o"]) {
      env.send(socket, { type: "terminal.data", sessionId: session.id, data: key });
    }
    await vi.waitFor(() => {
      const pane = env.fake.sessions.get(session.tmuxSession);
      expect(pane?.paneLines).toEqual(["hello"]);
    });
    // One tmux invocation carries the whole burst; exactly one extra capture
    // poke runs instead of one per keystroke.
    const sendKeys = env.fake.invocations.filter((inv) => inv.args[0] === "send-keys");
    expect(sendKeys.length).toBe(before + 1);
    expect(sendKeys.at(-1)?.args.slice(-5)).toEqual(["68", "65", "6c", "6c", "6f"]);
  });

  it("chunks input payloads larger than inputChunkBytes", async () => {
    env = setupHarness({ inputChunkBytes: 4, inputFlushMs: 0 });
    const session = await env.seedSession();
    const socket = env.open();
    env.send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));

    env.send(socket, { type: "terminal.data", sessionId: session.id, data: "abcdefghij" });
    await vi.waitFor(() => {
      const pane = env.fake.sessions.get(session.tmuxSession);
      // 10 bytes / 4-byte chunks → three invocations for one burst,
      // delivered in order (pane content is the concatenation).
      expect(pane?.paneLines.join("")).toBe("abcdefghij");
    });
    const sendKeys = env.fake.invocations.filter((inv) => inv.args[0] === "send-keys");
    expect(sendKeys.length).toBe(3);
    expect(sendKeys[0]?.args.slice(-4)).toEqual(["61", "62", "63", "64"]);
    expect(sendKeys[2]?.args.slice(-2)).toEqual(["69", "6a"]);
  });
});

describe("TerminalBridge: event-driven output", () => {
  it("captures only the visible screen while polling (not the full scrollback)", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `hist-${i}`);
    const session = await env.seedSession({ lines });
    const socket = env.open();
    env.send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));

    env.fake.invocations.length = 0;
    env.fake.sessions.get(session.tmuxSession)?.paneLines.push("screen tick");
    await vi.waitFor(() =>
      expect(socket.dataEvents().at(-1)?.data).toContain("screen tick"),
    );

    // Every poll capture since the attach is screen-only (-S -24); the
    // full-scrollback capture (-S -100) happened once, at attach.
    const captures = env.fake.invocations.filter(
      (inv) => inv.args[0] === "capture-pane" && inv.args.includes("-S"),
    );
    expect(captures.length).toBeGreaterThan(0);
    for (const capture of captures) {
      const sIdx = capture.args.indexOf("-S");
      expect(capture.args[sIdx + 1]).toBe("-24");
    }
  });

  it("streams output via the pipe-pane event source and stops the pipe on dispose", async () => {
    const session = await env.seedSession({ lines: ["initial"] });
    const socket = env.open();
    env.send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));

    // The event source started a pipe-pane writing to a stream file.
    const streamPath = env.fake.pipeStreamPath(session.tmuxSession);
    expect(streamPath).toBeDefined();
    expect(existsSync(streamPath!)).toBe(true);

    // Pane output lands in the stream file (fake mirrors the real pipe).
    env.fake.notifyOutput(session.tmuxSession, "event-driven output\n");
    await vi.waitFor(() =>
      expect(socket.dataEvents().at(-1)?.data).toContain("event-driven output"),
    );

    env.send(socket, { type: "terminal.detach", sessionId: session.id });
    await vi.waitFor(() => expect(env.fake.pipeActive(session.tmuxSession)).toBe(false));
    // Stream directory is cleaned up.
    await vi.waitFor(() => expect(existsSync(path.dirname(streamPath!))).toBe(false));
  });

  it("captures immediately on pipe events without waiting for a timer tick", async () => {
    const session = await env.seedSession({ lines: ["init"] });
    const socket = env.open();
    env.send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));

    // Burst of output delivered as a single pipe event; the data frame must
    // arrive promptly via the event — not the (5ms here) timer cadence.
    const t0 = Date.now();
    env.fake.notifyOutput(session.tmuxSession, "fast event\n");
    await vi.waitFor(() =>
      expect(socket.dataEvents().at(-1)?.data).toContain("fast event"),
    );
    expect(Date.now() - t0).toBeLessThan(5000); // generous CI bound; typically ~10ms
  });

  it("falls back to timer polling when the event stream never starts", async () => {
    // Simulate an environment without fs.watch support: the event source is
    // disabled entirely, so the adaptive poll loop drives output as before.
    env = setupHarness({ disableEventSource: true });
    const session = await env.seedSession({ lines: ["idle-start"] });
    const socket = env.open();
    env.send(socket, { type: "terminal.attach", sessionId: session.id, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.dataEvents().length).toBeGreaterThan(0));
    expect(env.fake.pipeActive(session.tmuxSession)).toBe(false);

    env.fake.sessions.get(session.tmuxSession)?.paneLines.push("polled output");
    await vi.waitFor(() =>
      expect(socket.dataEvents().at(-1)?.data).toContain("polled output"),
    );
  });
});
