/**
 * Tests for the click-to-update banner (issue #76). The fetching/polling
 * wrapper is trivial; the pure view is exercised directly with contract
 * parsed statuses (same pattern as the terminal session-picker tests).
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { UpdateStatusResponse } from "@agentskiss/shared";
import { updateStatusResponseSchema } from "@agentskiss/shared";

import { UpdateBannerView, type UpdateBannerViewProps } from "./UpdateBanner";

function status(overrides: Partial<UpdateStatusResponse> = {}): UpdateStatusResponse {
  return updateStatusResponseSchema.parse({
    repo: "ercs-second-brain/agentsKISS",
    ref: "main",
    localSha: "a".repeat(40),
    remoteSha: "b".repeat(40),
    updateAvailable: true,
    checkedAt: "2026-01-02T03:04:05.000Z",
    error: null,
    activeWorkers: 0,
    ...overrides,
  });
}

function view(overrides: Partial<UpdateBannerViewProps> = {}): string {
  return renderToString(
    <UpdateBannerView
      status={status()}
      phase="idle"
      targetSha={null}
      downMs={null}
      error={null}
      onApply={() => {}}
      {...overrides}
    />,
  );
}

describe("UpdateBannerView — update available (idle)", () => {
  it("renders the new short SHA and an enabled update button when all agents are idle", () => {
    const html = view();
    expect(html).toContain("update-banner");
    expect(html).toContain("b".repeat(7));
    expect(html).toContain("ercs-second-brain/agentsKISS@main");
    expect(html).toContain("Update now");
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("update-banner-hint");
  });

  it("disables the button with a hint while workers are active", () => {
    const html = view({ status: status({ activeWorkers: 2 }) });
    expect(html).toContain("disabled");
    expect(html).toContain("2 agents still working");
    expect(html).toContain("until all agents are idle");
  });

  it("singularizes the blocked hint for one active worker", () => {
    const html = view({ status: status({ activeWorkers: 1 }) });
    expect(html).toContain("1 agent still working");
  });

  it("shows an apply error while keeping the button available for a retry", () => {
    const html = view({ error: "POST /api/update/apply failed: 409 update blocked" });
    expect(html).toContain("update-banner-error");
    expect(html).toContain("update blocked");
    expect(html).toContain("Update now");
  });

  it("renders nothing when the install is up to date", () => {
    expect(view({ status: status({ localSha: "b".repeat(40), updateAvailable: false }) })).not.toContain("update-banner");
  });

  it("renders nothing when the check failed", () => {
    expect(
      view({ status: status({ remoteSha: null, updateAvailable: false, error: "gh exploded" }) }),
    ).not.toContain("update-banner");
  });

  it("renders nothing while the status is loading", () => {
    expect(view({ status: null })).not.toContain("update-banner");
  });
});

describe("UpdateBannerView — updating (apply accepted)", () => {
  it("shows the updating state with the target short SHA", () => {
    const html = view({ phase: "updating", targetSha: "b".repeat(40) });
    expect(html).toContain("update-banner updating");
    expect(html).toContain("Updating agentsKISS");
    expect(html).toContain("b".repeat(7));
    expect(html).toContain("restarts as part of the update");
    expect(html).not.toContain("Update now");
  });

  it("stays quiet about recovery while the daemon outage is short", () => {
    const html = view({ phase: "updating", targetSha: "b".repeat(40), downMs: 5_000 });
    expect(html).not.toContain("update-banner-hint");
  });

  it("surfaces the recovery hint when the daemon has been down for a while", () => {
    const html = view({ phase: "updating", targetSha: "b".repeat(40), downMs: 120_000 });
    expect(html).toContain("update-banner-hint");
    expect(html).toContain("agentskiss update");
    expect(html).toContain("agentskiss service status");
  });
});
