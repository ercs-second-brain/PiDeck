import { describe, expect, it } from "vitest";
import { RingBuffer } from "./ring-buffer.js";

describe("RingBuffer", () => {
  it("replays pushed chunks in order", () => {
    const ring = new RingBuffer(100);
    ring.push(Buffer.from("hello "));
    ring.push(Buffer.from("world"));
    expect(ring.replay().toString()).toBe("hello world");
    expect(ring.size).toBe(11);
  });

  it("drops the oldest bytes once over capacity", () => {
    const ring = new RingBuffer(10);
    ring.push(Buffer.from("abcdefghij"));
    ring.push(Buffer.from("0123456789"));
    expect(ring.size).toBe(10);
    expect(ring.replay().toString()).toBe("0123456789");
  });

  it("keeps only the tail of a chunk larger than capacity", () => {
    const ring = new RingBuffer(4);
    ring.push(Buffer.from("abcdefg"));
    expect(ring.replay().toString()).toBe("defg");
  });

  it("returns an empty buffer when empty", () => {
    expect(new RingBuffer(10).replay().length).toBe(0);
  });
});