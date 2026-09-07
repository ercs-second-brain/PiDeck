/**
 * Tests for the self-update banner (issue #55). The fetching wrapper is
 * trivial; the pure view is exercised directly with contract-parsed statuses
 * (same pattern as the terminal session-picker tests).
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { UpdateStatus } from "@agentskiss/shared";
import { updateStatusSchema } from "@agentskiss/shared";

import { UpdateBannerView } from "./UpdateBanner";

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return updateStatusSchema.parse({
    repo: "ercs-second-brain/agentsKISS",
    ref: "main",
    localSha: "a".repeat(40),
    remoteSha: "b".repeat(40),
    updateAvailable: true,
    checkedAt: "2026-01-02T03:04:05.000Z",
    error: null,
    ...overrides,
  });
}

describe("UpdateBannerView", () => {
  it("renders the new short SHA and the apply command when an update is available", () => {
    const html = renderToString(<UpdateBannerView status={status()} />);
    expect(html).toContain("update-banner");
    expect(html).toContain("b".repeat(7));
    expect(html).toContain("agentskiss update");
    expect(html).toContain("ercs-second-brain/agentsKISS@main");
  });

  it("renders nothing when the install is up to date", () => {
    const html = renderToString(<UpdateBannerView status={status({ localSha: "b".repeat(40), updateAvailable: false })} />);
    expect(html).not.toContain("update-banner");
  });

  it("renders nothing when the check failed (the CLI reports errors loudly)", () => {
    const html = renderToString(
      <UpdateBannerView status={status({ remoteSha: null, updateAvailable: false, error: "gh exploded" })} />,
    );
    expect(html).not.toContain("update-banner");
  });

  it("renders nothing while the status is loading", () => {
    expect(renderToString(<UpdateBannerView status={null} />)).not.toContain("update-banner");
  });
});
