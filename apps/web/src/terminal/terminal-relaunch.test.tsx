/**
 * Tests for the relaunch affordance (issue #117): a dead pane (session
 * ended / unavailable) offers a relaunch button in the bottom status bar
 * instead of dead-ending; live and transitioning states offer nothing.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

// StatusBar is exported from TerminalPane, which imports the xterm browser
// modules; stub them so the component can be imported in a node test env.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { StatusBar, relaunchOffered } from "./TerminalPane";
import type { TerminalStatus } from "./connection";

describe("relaunchOffered (issue #117)", () => {
  it("offers relaunch only for dead-pane states", () => {
    const offered: Record<TerminalStatus, boolean> = {
      connecting: false,
      attached: false,
      reconnecting: false,
      exited: true,
      unavailable: true,
      detached: false,
    };
    for (const [status, expected] of Object.entries(offered)) {
      expect(relaunchOffered(status as TerminalStatus)).toBe(expected);
    }
  });
});

function renderBar(status: TerminalStatus, overrides: Partial<Parameters<typeof StatusBar>[0]> = {}) {
  return renderToString(
    <StatusBar
      status={status}
      relaunching={false}
      relaunchError={null}
      onRelaunch={() => {}}
      {...overrides}
    />,
  );
}

describe("relaunch status bar (issue #117)", () => {
  it("shows the relaunch button when the session exited", () => {
    const html = renderBar("exited");
    expect(html).toContain("terminal-relaunch");
    expect(html).toContain("Relaunch");
    expect(html).toContain('aria-label="Relaunch session"');
  });

  it("shows the relaunch button when the session is unavailable", () => {
    expect(renderBar("unavailable")).toContain("terminal-relaunch");
  });

  it("offers no relaunch while the pane is live or transitioning", () => {
    for (const status of ["attached", "connecting", "reconnecting", "detached"] as TerminalStatus[]) {
      expect(renderBar(status)).not.toContain("terminal-relaunch");
    }
  });

  it("disables and relabels the button while relaunching", () => {
    const html = renderBar("exited", { relaunching: true });
    expect(html).toContain("Relaunching…");
    expect(html).toContain("disabled");
  });

  it("surfaces a relaunch failure in the status bar", () => {
    const html = renderBar("exited", { relaunchError: "daemon unreachable" });
    expect(html).toContain("Relaunch failed:");
    expect(html).toContain("daemon unreachable");
    // The affordance stays available so the user can retry.
    expect(html).toContain("terminal-relaunch");
  });
});
