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

  it("sits the agent-assets entry above settings in the footer (issue #315)", () => {
    const html = renderPicker();
    expect(html).toContain("picker-footer-agent-assets");
    expect(html).toContain("Agent assets — per-persona prompts &amp; skills");
    // Ordering inside the footer: agent assets first, settings last.
    expect(html.indexOf("picker-footer-agent-assets")).toBeGreaterThan(html.indexOf("picker-footer"));
    expect(html.indexOf("picker-footer-agent-assets")).toBeLessThan(html.indexOf("picker-footer-settings"));
  });

  it("anchors the update popup inside the footer, above the settings entry (issue #260)", () => {
    const html = renderToString(
      <SessionPicker
        entries={[]}
        error={null}
        selectedSessionId={null}
        onSelectSession={() => {}}
        onSelectProject={() => {}}
        onOpenSettings={() => {}}
        onSelectAllProjects={() => {}}
        onStartOnboarding={() => {}}
        onOpenGlobalSettings={() => {}}
        onStartOrchestrator={() => {}}
        updateSlot={
          <div className="update-popup">
            <div className="update-banner">Update available</div>
          </div>
        }
      />,
    );
    expect(html).toContain("update-popup");
    expect(html).toContain("Update available");
    // The popup precedes the settings button within the footer block.
    const footer = html.indexOf("picker-footer");
    expect(html.indexOf("update-popup")).toBeGreaterThan(footer);
    expect(html.indexOf("update-popup")).toBeLessThan(html.indexOf("picker-footer-settings"));
  });
});
