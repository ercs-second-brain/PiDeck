/**
 * Tests for the click-to-update banner (issue #76). The fetching/polling
 * wrapper is trivial; the pure view is exercised directly with contract
 * parsed statuses (same pattern as the terminal session-picker tests).
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { UpdateStatusResponse } from "@pideck/shared";
import { updateStatusResponseSchema } from "@pideck/shared";

import { UpdateBannerView, formatElapsed, updatingText, type UpdateBannerViewProps } from "./UpdateBanner";

function status(overrides: Partial<UpdateStatusResponse> = {}): UpdateStatusResponse {
  return updateStatusResponseSchema.parse({
    repo: "ercs-second-brain/agentsKISS",
    ref: "main",
    localSha: "a".repeat(40),
    remoteSha: "b".repeat(40),
    runningSha: "a".repeat(40),
    applyProgress: null,
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
      updating={null}
      reloading={false}
      reloadSha={null}
      reconnecting={false}
      error={null}
      onApply={() => {}}
      onReload={() => {}}
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

describe("UpdateBannerView — updating (apply accepted, modal over the dimmed app #113)", () => {
  function updating(overrides: Partial<UpdateBannerViewProps["updating"]> = {}): NonNullable<UpdateBannerViewProps["updating"]> {
    return { targetSha: "b".repeat(40), startedAt: 0, elapsedMs: 5_000, stage: null, apiUp: true, downMs: 0, ...overrides };
  }

  it("renders the full-screen updating modal with the target short SHA and an elapsed clock", () => {
    const html = view({ phase: "updating", updating: updating() });
    expect(html).toContain("update-modal-overlay");
    expect(html).toContain("update-modal");
    expect(html).toContain("Updating PiDeck");
    expect(html).toContain("b".repeat(7));
    expect(html).toContain("5s</strong> elapsed");
    expect(html).toContain("applying the update");
    expect(html).not.toContain("Update now");
  });

  it("shows the shim's rebuild stage while the daemon is up (issue #89)", () => {
    const html = view({ phase: "updating", updating: updating({ stage: "building", elapsedMs: 185_000 }) });
    expect(html).toContain("rebuilding");
    expect(html).toContain("3m 05s");
  });

  it("says the daemon is restarting once the API is unreachable (issue #89)", () => {
    const html = view({ phase: "updating", updating: updating({ apiUp: false, downMs: 10_000 }) });
    expect(html).toContain("daemon restarting");
    expect(html).not.toContain("update-banner-hint");
  });

  it("stays quiet about recovery while the daemon outage is short", () => {
    const html = view({ phase: "updating", updating: updating({ apiUp: false, downMs: 5_000 }) });
    expect(html).not.toContain("update-banner-hint");
  });

  it("surfaces the recovery hint when the daemon has been down for a while", () => {
    const html = view({ phase: "updating", updating: updating({ apiUp: false, downMs: 120_000 }) });
    expect(html).toContain("update-banner-hint");
    expect(html).toContain("pideck update");
    expect(html).toContain("pideck service status");
  });

  it("renders no modal while browsing normally (only an actual apply)", () => {
    expect(view()).not.toContain("update-modal");
  });
});

describe("UpdateBannerView — reload affordances (issue #89)", () => {
  it("shows the one-click reload when a CLI update landed under an open page", () => {
    const html = view({ reloadSha: "c".repeat(40) });
    expect(html).toContain("update-banner");
    expect(html).toContain("c".repeat(7));
    expect(html).toContain("Reload new build");
    expect(html).toContain("while this page was open");
  });

  it("shows the completion state in the modal while a banner-initiated apply reloads the page", () => {
    const html = view({ reloading: true });
    expect(html).toContain("update-modal-overlay");
    expect(html).toContain("Update complete");
    expect(html).not.toContain("Reload new build");
  });

  it("says it is waiting for the daemon while an idle page lost the API", () => {
    const html = view({ reconnecting: true });
    expect(html).toContain("Connection to the daemon was lost");
    expect(html).not.toContain("Reload new build");
  });
});

describe("formatElapsed / updatingText (issue #89)", () => {
  it("formats the elapsed clock compactly", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(185_000)).toBe("3m 05s");
    expect(formatElapsed(3_723_000)).toBe("1h 02m");
    expect(formatElapsed(-5)).toBe("0s");
  });

  it("maps known shim stages, passes unknown ones through, and falls back honestly", () => {
    expect(updatingText("building", true)).toContain("rebuilding");
    expect(updatingText("mystery", true)).toBe("update stage: mystery");
    expect(updatingText(null, false)).toContain("daemon restarting");
    expect(updatingText(null, true)).toBe("applying the update");
  });
});
