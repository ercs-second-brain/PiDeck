/**
 * Unit tests for the terminal input batcher (issue #67): keystroke bursts
 * leave as one frame, boundary keystrokes flush early, and pending input is
 * never held past the starvation guard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputBatcher } from "./input-batcher";

describe("InputBatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst of keystrokes into a single frame", () => {
    const frames: string[] = [];
    const batcher = new InputBatcher((data) => frames.push(data));
    for (const key of ["h", "e", "l", "l", "o"]) batcher.add(key);
    // One macrotask tick delivers the batch.
    vi.advanceTimersByTime(1);
    expect(frames).toEqual(["hello"]);
    batcher.close();
  });

  it("sends a boundary keystroke (Enter) immediately, flushing pending input", () => {
    const frames: string[] = [];
    const batcher = new InputBatcher((data) => frames.push(data));
    batcher.add("ls -l");
    expect(frames).toEqual([]); // still pending
    batcher.add("\r");
    expect(frames).toEqual(["ls -l\r"]); // flushed before the tick
    vi.advanceTimersByTime(1);
    expect(frames).toEqual(["ls -l\r"]); // no duplicate flush
    batcher.close();
  });

  it("separates bursts that arrive in different ticks", () => {
    const frames: string[] = [];
    const batcher = new InputBatcher((data) => frames.push(data));
    batcher.add("fir");
    vi.advanceTimersByTime(1);
    batcher.add("sec");
    vi.advanceTimersByTime(1);
    expect(frames).toEqual(["fir", "sec"]);
    batcher.close();
  });

  it("forces a flush when the macrotask queue is saturated", () => {
    const frames: string[] = [];
    const batcher = new InputBatcher((data) => frames.push(data), 16);
    // Simulate saturation: batches keep being scheduled but the flush timer
    // never gets to run because add() keeps arriving first.
    batcher.add("a");
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(5); // push time past the max batch delay
      batcher.add("b"); // re-schedules before the pending flush runs
    }
    // The starvation guard queued a forced flush.
    vi.advanceTimersByTime(1);
    expect(frames.length).toBeGreaterThan(0);
    batcher.close();
  });

  it("close() flushes pending input and ignores later adds", () => {
    const frames: string[] = [];
    const batcher = new InputBatcher((data) => frames.push(data));
    batcher.add("tail");
    batcher.close();
    expect(frames).toEqual(["tail"]);
    batcher.add("ignored");
    vi.advanceTimersByTime(1);
    expect(frames).toEqual(["tail"]);
  });

  it("ignores empty input", () => {
    const frames: string[] = [];
    const batcher = new InputBatcher((data) => frames.push(data));
    batcher.add("");
    vi.advanceTimersByTime(1);
    expect(frames).toEqual([]);
    batcher.close();
  });
});
