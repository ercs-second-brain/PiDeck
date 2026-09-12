/**
 * Unit tests for the terminal input batcher: keystroke coalescing into
 * fewer, larger WebSocket frames. Pure node.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputBatcher } from "./input-batcher";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("InputBatcher", () => {
  it("sends each burst of keystrokes as one frame", () => {
    const send = vi.fn();
    const batcher = new InputBatcher(send);
    batcher.add("h");
    batcher.add("e");
    batcher.add("l");
    batcher.add("l");
    batcher.add("o");
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledExactlyOnceWith("hello");
  });

  it("flushes early on boundary keystrokes so commands submit promptly", () => {
    const send = vi.fn();
    const batcher = new InputBatcher(send);
    batcher.add("l");
    batcher.add("s");
    batcher.add("\r");
    expect(send).toHaveBeenCalledExactlyOnceWith("ls\r");
  });

  it("separates two bursts that arrive in different ticks", () => {
    const send = vi.fn();
    const batcher = new InputBatcher(send);
    batcher.add("ls");
    vi.advanceTimersByTime(1);
    batcher.add("-la");
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, "ls");
    expect(send).toHaveBeenNthCalledWith(2, "-la");
  });

  it("forces a flush when macrotasks are starved", () => {
    const send = vi.fn();
    const batcher = new InputBatcher(send, 16);
    batcher.add("a");
    // Keep the loop saturated: no macrotask runs for 20ms.
    for (let i = 0; i < 5; i++) batcher.add("a");
    vi.advanceTimersByTime(20);
    expect(send).toHaveBeenCalledExactlyOnceWith("aaaaaa");
  });

  it("close flushes anything pending and ignores further input", () => {
    const send = vi.fn();
    const batcher = new InputBatcher(send);
    batcher.add("tail");
    batcher.close();
    batcher.add("more");
    expect(send).toHaveBeenCalledExactlyOnceWith("tail");
  });

  it("ignores empty input", () => {
    const send = vi.fn();
    const batcher = new InputBatcher(send);
    batcher.add("");
    vi.advanceTimersByTime(10);
    expect(send).not.toHaveBeenCalled();
  });
});