/**
 * Unit tests for the shared TTL+SWR cache's `onChange` hook (issue #451): a
 * background (SWR) refresh that re-derives a *different* value used to sit
 * silently in the daemon cache until the caller's next poll — the kanban's
 * "navigate, wait a few seconds, then it updates" lag. The hook lets the
 * kanban service announce the refreshed board the moment it lands.
 */

import { describe, expect, it } from "vitest";

import { TtlSwrCache } from "./swr-cache.js";

describe("TtlSwrCache onChange (issue #451)", () => {
  it("fires when a background refresh replaces the value with a different one", async () => {
    const now = { value: 1_000 };
    const seen: Array<{ key: string; previous: string; next: string }> = [];
    const cache = new TtlSwrCache<string>({
      ttlMs: 1_000,
      now: () => now.value,
      onChange: (key, previous, next) => seen.push({ key, previous, next }),
    });
    let served = "old";
    await cache.get("k", async () => served);
    now.value = 2_001; // past the TTL → SWR path
    served = "new";
    await cache.get("k", async () => served); // stale served, refresh kicked
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([{ key: "k", previous: "old", next: "new" }]);
  });

  it("does not fire when the background refresh returns the same value", async () => {
    const now = { value: 1_000 };
    const seen: string[] = [];
    const cache = new TtlSwrCache<string>({
      ttlMs: 1_000,
      now: () => now.value,
      onChange: (key) => seen.push(key),
    });
    await cache.get("k", async () => "same");
    now.value = 2_001;
    await cache.get("k", async () => "same");
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([]);
  });

  it("does not fire for fresh hits, cold fetches, or explicit refreshes", async () => {
    const now = { value: 1_000 };
    const seen: string[] = [];
    const cache = new TtlSwrCache<string>({
      ttlMs: 1_000,
      now: () => now.value,
      onChange: (key) => seen.push(key),
    });
    const served = "v";
    await cache.get("k", async () => served); // cold fetch
    await cache.get("k", async () => served); // fresh hit
    await cache.refresh("k", async () => served); // explicit refresh
    expect(seen).toEqual([]);
  });

  it("does not fire when the background refresh fails (stale value kept)", async () => {
    const now = { value: 1_000 };
    const seen: string[] = [];
    const cache = new TtlSwrCache<string>({
      ttlMs: 1_000,
      now: () => now.value,
      onChange: (key) => seen.push(key),
    });
    await cache.get("k", async () => "old");
    now.value = 2_001;
    await cache.get("k", async () => {
      throw new Error("gh exploded");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([]);
    // The stale value survives.
    await expect(cache.get("k", async () => "new")).resolves.toBe("old");
  });
});