/**
 * Tests for the kanban workers panel's archived filter (issue #102):
 * terminated (`archived`) workers disappear from the panel — they live only
 * in the terminal sidebar's archived section — while live workers render.
 * Pure view, rendered with contract-parsed workers (same pattern as the
 * update-banner / session-picker tests).
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { Worker } from "@agentskiss/shared";
import { workerSchema } from "@agentskiss/shared";

import { WorkersPanel } from "./WorkersPanel";

function worker(overrides: Partial<Worker> = {}): Worker {
  return workerSchema.parse({
    id: "worker-1",
    projectId: "o-r",
    sessionId: "sess-1",
    issueNumber: 7,
    prNumber: null,
    status: "running",
    statusMessage: "agent running in tmux session",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function render(workers: Worker[]): string {
  // MemoryRouter: the panel renders PR `Link`s, which need a router context.
  return renderToString(
    <MemoryRouter>
      <WorkersPanel projectId="o-r" workers={workers} />
    </MemoryRouter>,
  );
}

describe("WorkersPanel (issue #102)", () => {
  it("lists live workers with their status badge", () => {
    const html = render([worker({ id: "worker-live", status: "running" })]);
    expect(html).toContain("worker-live");
    // Issue #112: shared status-indicator classes (blue working tone + pulse).
    expect(html).toContain("badge-status");
    expect(html).toContain("status-indicator-working");
    expect(html).toContain("status-indicator-pulse");
  });

  it("maps the indicator tones across the worker lifecycle (issue #112)", () => {
    expect(render([worker({ id: "w", status: "awaiting_ci" })])).toContain("status-indicator-pr-ready");
    expect(render([worker({ id: "w", status: "addressing_review" })])).toContain("status-indicator-fixing");
    const done = render([worker({ id: "w", status: "done" })]);
    expect(done).toContain("status-indicator-idle");
    expect(done).not.toContain("status-indicator-pulse");
  });

  it("hides archived workers from the panel", () => {
    const html = render([
      worker({ id: "worker-live", status: "running" }),
      worker({ id: "worker-gone", status: "archived", statusMessage: "archived: terminated from the webapp" }),
    ]);
    expect(html).toContain("worker-live");
    expect(html).not.toContain("worker-gone");
  });

  it("counts only the listed (non-archived) workers", () => {
    const both = render([worker({ id: "worker-live" }), worker({ id: "worker-gone", status: "archived" })]);
    expect(both).toContain('class="panel-count">1<');
    const none = render([worker({ id: "worker-gone", status: "archived" })]);
    expect(none).toContain('class="panel-count">0<');
    expect(none).toContain("No workers running.");
  });
});
