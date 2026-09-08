/**
 * Tests for the sidebar's persistent footer (issue #176): a global-settings
 * button pinned at the bottom of the projects sidebar — visible regardless
 * of project-list state (empty, loading, or daemon error), since global
 * settings must stay one click away. The picker is pure, so it is exercised
 * directly without xterm or effects.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { SessionPicker } from "./SessionPicker";

function renderPicker(overrides: Partial<Parameters<typeof SessionPicker>[0]> = {}): string {
  return renderToString(
    <SessionPicker
      entries={overrides.entries ?? []}
      error={overrides.error ?? null}
      loading={overrides.loading}
      selectedSessionId={overrides.selectedSessionId ?? null}
      onSelectSession={() => {}}
      onSelectProject={() => {}}
      onOpenSettings={() => {}}
      onSelectAllProjects={() => {}}
      onStartOnboarding={() => {}}
      onOpenGlobalSettings={() => {}}
      onStartOrchestrator={() => {}}
    />,
  );
}

describe("picker footer (global settings, issue #176)", () => {
  it("pins a global-settings button in a footer at the sidebar's bottom", () => {
    const html = renderPicker();
    expect(html).toContain("picker-footer");
    expect(html).toContain("picker-footer-settings");
    expect(html).toContain("Global settings");
    // The footer is the last block in the aside — pinned at the bottom.
    expect(html.indexOf("picker-footer")).toBeGreaterThan(html.indexOf("picker-add-row"));
    expect(html.endsWith("</aside>")).toBe(true);
  });

  it("renders the footer even with no projects, while loading, or on daemon errors", () => {
    expect(renderPicker()).toContain("picker-footer-settings");
    expect(renderPicker({ loading: true })).toContain("picker-footer-settings");
    expect(renderPicker({ error: "connection refused" })).toContain("picker-footer-settings");
  });
});
