/**
 * Tests for the click-to-update banner (issue #76). The fetching/polling
 * wrapper is trivial; the pure view is exercised directly with contract
 * parsed statuses (same pattern as the terminal session-picker tests).
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { UpdateStatusResponse } from "@pideck/shared";
import { updateStatusResponseSchema } from "@pideck/shared";

import {
  UpdateBannerView,
  clearStaleApplyError,
  formatElapsed,
  updatingText,
  type ApplyError,
  type UpdateBannerViewProps,
} from "./UpdateBanner";

function status(overrides: Partial<UpdateStatusResponse> = {}): UpdateStatusResponse {
  return updateStatusResponseSchema.parse({
    repo: "ercs-second-brain/agentsKISS",
    ref: "main",
    localSha: "a".repeat(40),
    remoteSha: "b".repeat(40),
    runningSha: "a".repeat(40),
    runningBehindSource: false,
    applyProgress: null,
    updateAvailable: true,
    checkedAt: "2026-01-02T03:04:05.000Z",
    error: null,
    activeWorkers: 0,
    nodeVersion: "v22.23.2",
    nodeMinVersion: "22.19.0",
    nodeTooOld: false,
    ...overrides,
  });
}

function view(overrides: Partial<UpdateBannerViewProps> = {}): string {
  return renderToString(
    <UpdateBannerView
      status={status()}
      phase="idle"
      updating={null}
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
  it("renders a compact offer: short SHA plus an enabled primary button when all agents are idle", () => {
    const html = view();
    // Issue #260: the strips live in a compact popup wrapper (anchored
    // above the sidebar's settings entry by the footer CSS). Issue #410:
    // one row — label + short SHA + button, no body text; the full ref
    // rides as a title on the SHA, the gate warning as a tooltip only.
    expect(html).toContain("update-popup");
    expect(html).toContain("update-offer");
    expect(html).toContain("b".repeat(7));
    expect(html).toContain('title="ercs-second-brain/agentsKISS@main"');
    expect(html).toContain("Update now");
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain("update-tooltip");
  });

  it("disables the button and carries the gate warning as an accessible tooltip while workers are active", () => {
    const html = view({ status: status({ activeWorkers: 2 }) });
    expect(html).toContain("disabled");
    // Issue #410: the warning is a tooltip (role=tooltip) linked from the
    // disabled button via aria-describedby — not body text.
    expect(html).toContain('aria-describedby="update-blocked-hint"');
    expect(html).toContain('role="tooltip"');
    expect(html).toContain("update-tooltip");
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
    const html = view({ status: status({ localSha: "b".repeat(40), updateAvailable: false }) });
    expect(html).not.toContain("update-banner");
    expect(html).not.toContain("update-popup");
  });

  it("renders the check error honestly instead of going quiet (issue #221)", () => {
    const html = view({ status: status({ remoteSha: null, updateAvailable: false, error: "gh exploded" }) });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Update check failed:");
    expect(html).toContain("gh exploded");
  });

  it("renders the live apply stage while a CLI-initiated apply runs (issue #221)", () => {
    const html = view({
      status: status({
        updateAvailable: false,
        applyProgress: { stage: "building", updatedAt: "2026-01-02T03:04:00Z" },
      }),
    });
    expect(html).toContain('role="status"');
    expect(html).toContain("rebuilding");
  });

  it("stays quiet once the apply reaches a terminal stage (no phantom strips, issue #221)", () => {
    // A failed apply keeps the regular (retryable) banner path — the failure
    // detail reaches users through the apply flow's own error state.
    const html = view({
      status: status({
        applyProgress: { stage: "failed", updatedAt: "2026-01-02T03:04:00Z", error: "build died" },
      }),
    });
    expect(html).toContain("Update available");
    expect(html).not.toContain("rebuilding");
    expect(html).not.toContain("build died");
  });

  it("renders nothing while the status is loading", () => {
    const html = view({ status: null });
    expect(html).not.toContain("update-banner");
    // No empty popup shell when quiet (issue #260).
    expect(html).not.toContain("update-popup");
  });
});

describe("UpdateBannerView — updating (apply accepted, modal over the dimmed app #113)", () => {
  function updating(overrides: Partial<UpdateBannerViewProps["updating"]> = {}): NonNullable<UpdateBannerViewProps["updating"]> {
    return { targetSha: "b".repeat(40), startedAt: 0, elapsedMs: 5_000, stage: null, apiUp: true, downMs: 0, ...overrides };
  }

  it("renders the bare updating modal — spinner, plain text, short SHA, elapsed clock (issue #450)", () => {
    const html = view({ phase: "updating", updating: updating() });
    expect(html).toContain("update-modal-overlay");
    expect(html).toContain("update-modal");
    expect(html).toContain("update-modal-spinner");
    expect(html).toContain("Updating PiDeck to");
    expect(html).toContain("b".repeat(7));
    expect(html).toContain("5s");
    expect(html).toContain("elapsed");
    expect(html).toContain("applying the update");
    expect(html).not.toContain("Update now");
    // Issue #450: no decorated chrome — no modal title heading, no bold
    // clock, no code-styled SHA.
    expect(html).not.toContain("modal-title");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<code>");
  });

  it("has no completion state — the page reloads straight into the new build (issue #450)", () => {
    const html = view({ phase: "updating", updating: updating() });
    expect(html).not.toContain("Update complete");
    expect(html).not.toContain("Reloading into the new build");
  });

  it("shows the shim's rebuild stage while the daemon is up (issue #89)", () => {
    const html = view({ phase: "updating", updating: updating({ stage: "building", elapsedMs: 185_000 }) });
    expect(html).toContain("rebuilding");
    expect(html).toContain("3m 05s");
    expect(html).toContain("elapsed");
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

  it("says it is waiting for the daemon while an idle page lost the API", () => {
    const html = view({ reconnecting: true });
    expect(html).toContain("Connection to the daemon was lost");
    expect(html).not.toContain("Reload new build");
  });

  it("renders no completion message on the idle page either (issue #450)", () => {
    // The banner-initiated path reloads the page on resolution; the idle
    // strips never carry an "update complete" line — quiet means quiet.
    const html = view();
    expect(html).not.toContain("Update complete");
  });
});

describe("stale apply error across detection cycles (issue #186)", () => {
  // The regression: apply A completes (or fails), then a NEW upstream SHA B
  // is detected — the banner must render a clean 'update available' cycle,
  // never the prior apply's failure.
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const failedApply: ApplyError = { sha: shaA, message: "The update failed while applying — run `pideck update` …" };

  it("clears the prior cycle's error once a different upstream SHA is detected", () => {
    expect(clearStaleApplyError(failedApply, status({ remoteSha: shaB }))).toBeNull();
  });

  it("keeps the error while the failed cycle's SHA is still the upstream head", () => {
    expect(clearStaleApplyError(failedApply, status({ remoteSha: shaA }))).toBe(failedApply);
  });

  it("keeps the error when the new check has no upstream SHA to compare against", () => {
    expect(clearStaleApplyError(failedApply, status({ remoteSha: null, updateAvailable: false }))).toBe(failedApply);
  });

  it("renders a clean 'update available' banner for the new SHA — no error text", () => {
    // The failed cycle's banner: available + error side by side.
    const stale = view({ error: failedApply.message });
    expect(stale).toContain("update-banner-error");
    // A new update becomes available (sha B): the cycle starts clean.
    const fresh = view({ status: status({ remoteSha: shaB, localSha: shaA }), error: null });
    expect(fresh).toContain("Update available");
    expect(fresh).toContain(shaB.slice(0, 7));
    expect(fresh).not.toContain("update-banner-error");
    expect(fresh).not.toContain("failed");
  });
});

describe("NodeTooOldStrip (issue #202: warn before pi crashes at runtime)", () => {
  it("warns loudly when the daemon's node is too old for pi", () => {
    const html = view({ status: status({ nodeTooOld: true, nodeVersion: "v22.14.0" }) });
    expect(html).toContain("update-banner");
    expect(html).toContain("v22.14.0");
    expect(html).toContain("too old for pi");
    expect(html).toContain("22.19.0");
    expect(html).toContain("pideck update");
  });

  it("stays quiet on a current node", () => {
    expect(view({ status: status({ nodeTooOld: false, updateAvailable: false }) })).not.toContain("too old for pi");
  });

  it("stacks the warning above the update offer when both apply", () => {
    const html = view({ status: status({ nodeTooOld: true }) });
    expect(html).toContain("too old for pi");
    expect(html).toContain("Update now");
    // The warning appears before the update offer in the document.
    expect(html.indexOf("too old for pi")).toBeLessThan(html.indexOf("Update now"));
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
