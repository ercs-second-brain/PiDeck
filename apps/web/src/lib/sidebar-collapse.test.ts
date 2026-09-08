/**
 * Tests for the sidebar's collapsed-project persistence (issue #114): the
 * set of collapsed projects survives reloads via localStorage; junk data
 * and missing storage fall back to the default (everything expanded).
 */

import { describe, expect, it } from "vitest";
import { loadCollapsedProjects, saveCollapsedProjects } from "./sidebar-collapse";

function fakeStorage(initial: Record<string, string> = {}): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

describe("sidebar collapse persistence (issue #114)", () => {
  it("defaults to expanded (empty set) with no stored state", () => {
    expect(loadCollapsedProjects(fakeStorage())).toEqual(new Set());
    expect(loadCollapsedProjects(fakeStorage({ "pideck.sidebar.collapsedProjects": "" }))).toEqual(new Set());
    expect(loadCollapsedProjects(undefined)).toEqual(new Set());
  });

  it("round-trips a set of collapsed project ids", () => {
    const store = fakeStorage();
    saveCollapsedProjects(new Set(["alpha", "beta"]), store);
    expect(loadCollapsedProjects(store)).toEqual(new Set(["alpha", "beta"]));
  });

  it("ignores junk payloads and non-string ids", () => {
    expect(loadCollapsedProjects(fakeStorage({ "pideck.sidebar.collapsedProjects": "not json" })).size).toBe(0);
    expect(
      loadCollapsedProjects(fakeStorage({ "pideck.sidebar.collapsedProjects": JSON.stringify(["a", 7, null]) })),
    ).toEqual(new Set(["a"]));
    expect(loadCollapsedProjects(fakeStorage({ "pideck.sidebar.collapsedProjects": JSON.stringify({ a: 1 }) })).size).toBe(0);
  });

  it("migrates a stored set from the pre-rebrand key once", () => {
    const store = fakeStorage({ "agentskiss.sidebar.collapsedProjects": JSON.stringify(["alpha"]) });
    expect(loadCollapsedProjects(store)).toEqual(new Set(["alpha"]));
    expect(store.data).toEqual({ "pideck.sidebar.collapsedProjects": JSON.stringify(["alpha"]) });
  });

  it("prefers the current key over the pre-rebrand key", () => {
    const store = fakeStorage({
      "pideck.sidebar.collapsedProjects": JSON.stringify(["new"]),
      "agentskiss.sidebar.collapsedProjects": JSON.stringify(["old"]),
    });
    expect(loadCollapsedProjects(store)).toEqual(new Set(["new"]));
  });
});
