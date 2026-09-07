/**
 * Issue #90 regression test: the first-run onboarding auto-open decision
 * must treat the not-yet-loaded sidebar as "loading", not "no projects" —
 * the wizard may only open after the project list actually loaded empty.
 *
 * (The hook's effects can't run in the node test environment, so the
 * decision is a pure helper exercised here and wired into the shell.)
 */

import { describe, expect, it } from "vitest";
import { shouldAutoOpenOnboarding } from "./sidebar";

describe("shouldAutoOpenOnboarding (issue #90)", () => {
  it("does not open while the project list is still loading", () => {
    expect(shouldAutoOpenOnboarding({ loaded: false, error: null, entryCount: 0 })).toBe(false);
  });

  it("opens only after a successful load of a genuinely empty project list", () => {
    expect(shouldAutoOpenOnboarding({ loaded: true, error: null, entryCount: 0 })).toBe(true);
  });

  it("does not open when projects exist", () => {
    expect(shouldAutoOpenOnboarding({ loaded: true, error: null, entryCount: 3 })).toBe(false);
  });

  it("does not open when the daemon is unreachable", () => {
    expect(shouldAutoOpenOnboarding({ loaded: false, error: "connection refused", entryCount: 0 })).toBe(false);
    expect(shouldAutoOpenOnboarding({ loaded: true, error: "connection refused", entryCount: 0 })).toBe(false);
  });
});
