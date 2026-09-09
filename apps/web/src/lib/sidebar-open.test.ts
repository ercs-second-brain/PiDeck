/**
 * Tests for the shell sidebar's persisted open state (issue #326): the
 * hamburger-toggled sidebar survives reloads via localStorage, defaulting
 * to open on desktop and closed on the mobile drawer breakpoint.
 *
 * Issue #364: the persisted state is per-viewport — the mobile drawer's
 * auto-close must not overwrite the desktop's persisted open/closed choice.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { isMobileViewport, loadSidebarOpen, saveSidebarOpen, shouldAutoCloseSidebar } from "./sidebar-open";

function memoryStore(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

/** Pretends the browser viewport is (or is not) at the mobile breakpoint. */
function stubViewport(mobile: boolean): void {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches: mobile && query === "(max-width: 768px)",
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sidebar open persistence (issue #326)", () => {
  it("defaults to open with no stored value", () => {
    stubViewport(false);
    expect(loadSidebarOpen(memoryStore())).toBe(true);
  });

  it("round-trips the stored state", () => {
    stubViewport(false);
    const store = memoryStore();
    saveSidebarOpen(false, store);
    expect(loadSidebarOpen(store)).toBe(false);
    saveSidebarOpen(true, store);
    expect(loadSidebarOpen(store)).toBe(true);
  });

  it("falls back to the default on junk values", () => {
    stubViewport(false);
    expect(loadSidebarOpen(memoryStore({ "pideck.sidebar.open.desktop": "yes" }))).toBe(true);
  });

  it("treats missing storage as the default, and saving as a no-op", () => {
    stubViewport(false);
    expect(loadSidebarOpen(undefined)).toBe(true);
    expect(() => saveSidebarOpen(false, undefined)).not.toThrow();
  });
});

describe("per-viewport persistence (issue #364)", () => {
  it("keeps desktop and mobile states in separate keys", () => {
    const store = memoryStore();
    stubViewport(false);
    saveSidebarOpen(false, store);
    stubViewport(true);
    saveSidebarOpen(true, store);
    // Each viewport reads back its own choice.
    stubViewport(false);
    expect(loadSidebarOpen(store)).toBe(false);
    stubViewport(true);
    expect(loadSidebarOpen(store)).toBe(true);
  });

  it("a mobile auto-close does not collapse the desktop's persisted choice", () => {
    const store = memoryStore();
    // Desktop user leaves the sidebar open (default, persisted explicitly).
    stubViewport(false);
    saveSidebarOpen(true, store);
    // Mobile navigation auto-closes the drawer and persists it.
    stubViewport(true);
    saveSidebarOpen(false, store);
    // The next desktop load still starts open.
    stubViewport(false);
    expect(loadSidebarOpen(store)).toBe(true);
  });

  it("mobile ignores the legacy shared key and uses its viewport default", () => {
    // Pre-#364 writes were shared; a stale "1" must not force the drawer open.
    stubViewport(true);
    expect(loadSidebarOpen(memoryStore({ "pideck.sidebar.open": "1" }))).toBe(false);
  });

  it("desktop honors the legacy shared key as a one-time fallback", () => {
    // An upgraded desktop keeps its pre-#364 choice…
    stubViewport(false);
    expect(loadSidebarOpen(memoryStore({ "pideck.sidebar.open": "0" }))).toBe(false);
    // …until its own per-viewport key is written.
    stubViewport(false);
    const store = memoryStore({ "pideck.sidebar.open": "0" });
    saveSidebarOpen(true, store);
    expect(loadSidebarOpen(store)).toBe(true);
  });

  it("mobile defaults to closed (drawer shut) with no stored value", () => {
    stubViewport(true);
    expect(loadSidebarOpen(memoryStore())).toBe(false);
    expect(loadSidebarOpen(undefined)).toBe(false);
  });
});

describe("sidebar auto-close rule (issue #354)", () => {
  it("auto-closes only on the mobile drawer breakpoint", () => {
    expect(shouldAutoCloseSidebar(true)).toBe(true);
    expect(shouldAutoCloseSidebar(false)).toBe(false);
  });

  it("reports desktop (non-mobile) when window/matchMedia are unavailable", () => {
    // Node test environment: no window — the sidebar must not behave as a drawer.
    expect(isMobileViewport()).toBe(false);
  });
});
