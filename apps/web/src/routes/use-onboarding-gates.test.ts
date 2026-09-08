/**
 * Tests for the onboarding gates' pure decision (issue #209): the global
 * PiDeck onboarding is skipped only when the live probes report both pi
 * and gh ready, or the recorded shell onboarding (onboarding.json,
 * issue #165) says it completed both — so a fully-configured machine
 * opens zero modals and is never re-asked.
 */
import { describe, expect, it } from "vitest";

import type { GhAuth, OnboardingState, PiAuth } from "../lib/api";
import { globalOnboardingDone } from "./use-onboarding-gates";

const PI_READY: PiAuth = { ready: true, providers: ["anthropic"], defaultProvider: "anthropic", defaultModel: "m", detail: "" };
const PI_NOT_READY: PiAuth = { ready: false, providers: [], defaultProvider: null, defaultModel: null, detail: "" };
const GH_READY: GhAuth = {
  authenticated: true,
  login: "octocat",
  tokenSource: "gh CLI",
  scopes: ["repo"],
  canCreateRepos: "yes",
  canCreatePrivateRepos: "yes",
  canCreatePublicRepos: "yes",
  detail: "",
};
const GH_NOT_READY: GhAuth = {
  authenticated: false,
  login: null,
  tokenSource: "none",
  scopes: [],
  canCreateRepos: "unknown",
  canCreatePrivateRepos: "unknown",
  canCreatePublicRepos: "unknown",
  detail: "",
};

function state(pi: PiAuth, gh: GhAuth, recorded: OnboardingState["recorded"] = null): OnboardingState {
  return { recorded, piAuth: pi, ghAuth: gh };
}

const RECORDED_DONE: NonNullable<OnboardingState["recorded"]> = {
  onboardedAt: "2026-02-01T10:00:00.000Z",
  pi: { authStatus: "ready", provider: "anthropic", model: "anthropic/claude-x" },
  gh: { authStatus: "ready", user: "octocat", canCreateRepo: true },
};

describe("globalOnboardingDone (issue #209)", () => {
  it("skips when both live probes report ready", () => {
    expect(globalOnboardingDone(state(PI_READY, GH_READY))).toBe(true);
  });

  it("does not skip when either probe is not ready and nothing is recorded", () => {
    expect(globalOnboardingDone(state(PI_NOT_READY, GH_READY))).toBe(false);
    expect(globalOnboardingDone(state(PI_READY, GH_NOT_READY))).toBe(false);
    expect(globalOnboardingDone(state(PI_NOT_READY, GH_NOT_READY))).toBe(false);
  });

  it("skips when the recorded shell onboarding completed both, even if probes lag", () => {
    expect(globalOnboardingDone(state(PI_NOT_READY, GH_NOT_READY, RECORDED_DONE))).toBe(true);
  });

  it("does not skip on a half-done recorded run", () => {
    expect(
      globalOnboardingDone(
        state(PI_NOT_READY, GH_NOT_READY, {
          ...RECORDED_DONE,
          gh: { authStatus: "none", user: null, canCreateRepo: null },
        }),
      ),
    ).toBe(false);
    expect(
      globalOnboardingDone(
        state(PI_NOT_READY, GH_NOT_READY, {
          ...RECORDED_DONE,
          pi: { authStatus: "none", provider: null, model: null },
        }),
      ),
    ).toBe(false);
  });

  it("does not skip when the shell onboarding never ran", () => {
    expect(globalOnboardingDone(state(PI_NOT_READY, GH_NOT_READY, null))).toBe(false);
  });
});
