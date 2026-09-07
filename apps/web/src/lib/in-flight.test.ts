/**
 * Regression tests for the fetch layer's in-flight coalescing (issue #88):
 * concurrent identical requests share one network call, settled entries
 * clear (retry after failure), and different keys never share.
 */

import { describe, expect, it, vi } from "vitest";
import { shareInFlight, type InFlight } from "./in-flight";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("shareInFlight", () => {
  it("coalesces concurrent identical keys into one run", async () => {
    const map: InFlight<number> = new Map();
    const run = vi.fn(async () => 1);
    const [a, b, c] = await Promise.all([
      shareInFlight(map, "GET /x", run),
      shareInFlight(map, "GET /x", run),
      shareInFlight(map, "GET /x", run),
    ]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(c).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not share different keys", async () => {
    const map: InFlight<number> = new Map();
    const run = vi.fn(async (key: string) => key.length);
    await Promise.all([
      shareInFlight(map, "GET /a", () => run("/a")),
      shareInFlight(map, "GET /b", () => run("/b")),
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("clears the entry on settle: the next call runs again", async () => {
    const map: InFlight<number> = new Map();
    const run = vi.fn(async () => 1);
    await shareInFlight(map, "GET /x", run);
    await shareInFlight(map, "GET /x", run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejections reach every sharer and clear the entry so failures retry", async () => {
    const map: InFlight<string> = new Map();
    const first = deferred<string>();
    const sharers = [shareInFlight(map, "GET /x", () => first.promise), shareInFlight(map, "GET /x", () => first.promise)];
    first.reject(new Error("boom"));
    await expect(sharers[0]).rejects.toThrow("boom");
    await expect(sharers[1]).rejects.toThrow("boom");
    expect(map.size).toBe(0);
    await expect(shareInFlight(map, "GET /x", async () => "fresh")).resolves.toBe("fresh");
  });
});
