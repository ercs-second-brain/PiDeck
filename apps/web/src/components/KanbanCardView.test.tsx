/**
 * Tests for the kanban card's worker files-changed link (issue #126): a
 * card driven by a worker links its worker badge to the per-worker
 * files-changed view; undriven cards render no link.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { KanbanCard } from "@agentskiss/shared";

import { KanbanCardView } from "./KanbanCardView";

function issueCard(workerId: string | null): KanbanCard {
  return {
    id: "issue-5",
    projectId: "demo",
    kind: "issue",
    number: 5,
    title: "Worker-centric diff browsing",
    column: "in_progress",
    workerId,
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

describe("KanbanCardView worker files-changed link", () => {
  it("links a driven card's worker badge to the files-changed view", () => {
    const html = renderToString(
      <MemoryRouter>
        <KanbanCardView card={issueCard("worker-abc123")} />
      </MemoryRouter>,
    );
    expect(html).toContain("/projects/demo/pulls/worker-abc123");
    expect(html).toContain("badge-worker");
    expect(html).toContain("card-worker-link");
  });

  it("renders no worker link when no worker drives the card", () => {
    const html = renderToString(
      <MemoryRouter>
        <KanbanCardView card={issueCard(null)} />
      </MemoryRouter>,
    );
    expect(html).not.toContain("card-worker-link");
  });
});
