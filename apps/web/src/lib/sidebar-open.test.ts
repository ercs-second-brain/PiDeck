/**
 * Tests for the shell sidebar's persisted open state (issue #326): the
 * hamburger-toggled sidebar survives reloads via localStorage, defaulting
 * to open on desktop and closed on the mobile drawer breakpoint.
 */

import { describe, expect, it } from "vitest";
import { loadSidebarOpen, saveSidebarOpen } from "./sidebar-open";

function memoryStore(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

describe("sidebar open persistence (issue #326)", () => {
  it("defaults to open with no stored value", () => {
    expect(loadSidebarOpen(memoryStore())).toBe(true);
  });

  it("round-trips the stored state", () => {
    const store = memoryStore();
    saveSidebarOpen(false, store);
    expect(loadSidebarOpen(store)).toBe(false);
    saveSidebarOpen(true, store);
    expect(loadSidebarOpen(store)).toBe(true);
  });

  it("falls back to the default on junk values", () => {
    expect(loadSidebarOpen(memoryStore({ "pideck.sidebar.open": "yes" }))).toBe(true);
  });

  it("treats missing storage as the default, and saving as a no-op", () => {
    expect(loadSidebarOpen(undefined)).toBe(true);
    expect(() => saveSidebarOpen(false, undefined)).not.toThrow();
  });
});
