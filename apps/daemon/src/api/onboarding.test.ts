/**
 * Tests for `GET /api/onboarding` (issue #165): the one shared source of
 * truth for onboarding state — the installer's recorded onboarding.json plus
 * the live pi/gh auth probes. Hermetic: pi probe via readyOverride, gh probe
 * via an in-memory GhRunner.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { GhClient, type GhRunner } from "../github/gh.js";
import { testDaemon } from "./testutil.js";
import { onboardingStatePayload, readRecordedOnboarding } from "./onboarding.js";

function ghRunner(login: string): GhRunner {
  return async (args) => {
    if (args[0] === "api" && args[1] === "-i" && args[2] === "/user") {
      return {
        stdout: "HTTP/1.1 200 OK\nx-oauth-scopes: repo, read:org\n\n" + JSON.stringify({ login }),
        stderr: "",
      };
    }
    throw new Error(`fake gh: unexpected args ${args.join(" ")}`);
  };
}

describe("readRecordedOnboarding", () => {
  it("normalizes the installer's onboarding.json (blanks → null)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pideck-onboarding-"));
    writeFileSync(
      path.join(dir, "onboarding.json"),
      JSON.stringify({
        onboardedAt: "2026-02-01T10:00:00.000Z",
        pi: { authStatus: "ready", provider: "anthropic", model: "anthropic/claude-x", readyProviders: "anthropic" },
        gh: { authStatus: "ready", user: "octocat", scopes: "repo", canCreateRepo: true, tokenSource: "environment" },
      }),
    );
    expect(readRecordedOnboarding(dir)).toEqual({
      onboardedAt: "2026-02-01T10:00:00.000Z",
      pi: { authStatus: "ready", provider: "anthropic", model: "anthropic/claude-x" },
      gh: { authStatus: "ready", user: "octocat", canCreateRepo: true },
    });
  });

  it("returns null for a missing or malformed file, and nulls for blank fields", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pideck-onboarding-"));
    expect(readRecordedOnboarding(dir)).toBeNull();
    writeFileSync(path.join(dir, "onboarding.json"), "not json");
    expect(readRecordedOnboarding(dir)).toBeNull();
    writeFileSync(
      path.join(dir, "onboarding.json"),
      JSON.stringify({
        onboardedAt: "2026-02-01T10:00:00.000Z",
        pi: { authStatus: "none", provider: "", model: "" },
        gh: { authStatus: "none" },
      }),
    );
    expect(readRecordedOnboarding(dir)).toEqual({
      onboardedAt: "2026-02-01T10:00:00.000Z",
      pi: { authStatus: "none", provider: null, model: null },
      gh: { authStatus: "none", user: null, canCreateRepo: null },
    });
  });
});

describe("onboardingStatePayload", () => {
  it("combines the recorded shell onboarding with the live pi/gh probes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pideck-onboarding-"));
    writeFileSync(
      path.join(dir, "onboarding.json"),
      JSON.stringify({
        onboardedAt: "2026-02-01T10:00:00.000Z",
        pi: { authStatus: "ready", provider: "anthropic", model: "" },
        gh: { authStatus: "ready", user: "octocat" },
      }),
    );
    const { services } = testDaemon({}, { stateDir: dir });
    const payload = await onboardingStatePayload(services, new GhClient(ghRunner("octocat")));
    expect(payload.recorded).toMatchObject({ onboardedAt: "2026-02-01T10:00:00.000Z", gh: { user: "octocat" } });
    // testDaemon's hermetic default: pi ready without probing the real CLI.
    expect(payload.piAuth.ready).toBe(true);
    expect(payload.ghAuth.authenticated).toBe(true);
    expect(payload.ghAuth.login).toBe("octocat");
  });

  it("reports null recorded state when the shell onboarding never ran", async () => {
    const { services } = testDaemon();
    const payload = await onboardingStatePayload(services, new GhClient(ghRunner("octocat")));
    expect(payload.recorded).toBeNull();
    expect(payload.piAuth.ready).toBe(true);
  });
});
