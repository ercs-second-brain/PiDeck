/**
 * Worker status → display-tone mapping (issue #112): blue = working,
 * green = PR up / ready again, red = fixing CI / addressing review, neutral
 * for idle/terminal. Pulse only while the agent is actively working.
 */

import { describe, expect, it } from "vitest";
import { workerStatusClasses, workerStatusIndicator } from "./worker-status";

describe("workerStatusIndicator (issue #112)", () => {
  it("maps actively-working statuses to the blue working tone with pulse", () => {
    for (const status of ["spawning", "running"] as const) {
      expect(workerStatusIndicator(status)).toEqual({ tone: "working", pulsing: true });
    }
  });

  it("maps awaiting_ci to the green PR-ready tone, solid", () => {
    expect(workerStatusIndicator("awaiting_ci")).toEqual({ tone: "pr-ready", pulsing: false });
  });

  it("maps the CI/review-fix loop to the red fixing tone with pulse", () => {
    for (const status of ["fixing_ci", "addressing_review"] as const) {
      expect(workerStatusIndicator(status)).toEqual({ tone: "fixing", pulsing: true });
    }
  });

  it("maps terminal/idle statuses to solid neutral", () => {
    for (const status of ["done", "failed", "stopped", "archived"] as const) {
      expect(workerStatusIndicator(status)).toEqual({ tone: "idle", pulsing: false });
    }
  });
});

describe("workerStatusClasses (issue #112)", () => {
  it("composes the base class with the tone and pulse classes", () => {
    expect(workerStatusClasses("running", "worker-badge")).toBe(
      "worker-badge status-indicator status-indicator-working status-indicator-pulse",
    );
    expect(workerStatusClasses("done", "badge badge-status")).toBe(
      "badge badge-status status-indicator status-indicator-idle",
    );
  });
});
