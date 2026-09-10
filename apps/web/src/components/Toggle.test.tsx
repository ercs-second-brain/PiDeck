/**
 * Tests for the shared toggle switch (issue #359): every on/off control in
 * the non-terminal UI renders through this one component instead of raw
 * checkboxes. Pure render tests (the repo's SSR pattern): the switch is a
 * real checkbox input with `role="switch"` — semantics and keyboard
 * operation (space toggles, focus-visible ring) are the platform's, backed
 * by the `.toggle-input`/`.toggle-switch` chrome in index.css.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import { Toggle } from "./Toggle";

describe("Toggle (issue #359)", () => {
  it("renders a real checkbox switch with its label", () => {
    const html = renderToString(<Toggle checked={false} onToggle={() => {}} label="Auto review agents" />);
    // One component, one chrome: the input carries semantics, the track is
    // decoration, the label is the row's text.
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('role="switch"');
    expect(html).toContain("toggle-input");
    expect(html).toContain("toggle-switch");
    expect(html).toContain("toggle-label");
    expect(html).toContain("Auto review agents");
  });

  it("reflects the checked state as a checked input", () => {
    const on = renderToString(<Toggle checked onToggle={() => {}} label="On" />);
    expect(on).toContain("checked");
    const off = renderToString(<Toggle checked={false} onToggle={() => {}} label="Off" />);
    // React SSR omits the attribute when false — the unchecked switch is
    // a plain input.
    expect((on.match(/checked/g) ?? []).length).toBeGreaterThan(0);
    expect(off).not.toContain('type="checkbox" checked');
  });

  it("disables honestly: the input is disabled and the row drops the pointer affordance", () => {
    const html = renderToString(<Toggle checked={false} onToggle={() => {}} disabled label="Blocked" />);
    expect(html).toContain("disabled");
    expect(html).toContain("toggle-row-disabled");
  });

  it("renders label fragments (label + hint) inside the row", () => {
    const html = renderToString(
      <Toggle
        checked
        onToggle={() => {}}
        label={
          <>
            Browser notifications
            <small className="field-hint">Fires on merge.</small>
          </>
        }
      />,
    );
    expect(html).toContain("Browser notifications");
    expect(html).toContain("Fires on merge.");
    expect(html).toContain("field-hint");
  });
});