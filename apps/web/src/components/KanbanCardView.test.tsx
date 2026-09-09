/**
 * Tests for the kanban card's worker files-changed link (issue #126): a
 * card driven by a worker links its worker badge to the per-worker
 * files-changed view; undriven cards render no link.
 *
 * Also covers issue #261: cards link to the GitHub issue/PR URL when the
 * board payload carries it, and PR cards show +/- diff totals when the
 * payload resolved them.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { KanbanCard } from "@pideck/shared";

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

const prCard: KanbanCard = {
  id: "pr:demo:18",
  projectId: "demo",
  kind: "pull_request",
  number: 18,
  title: "Shared contracts",
  column: "in_review",
  workerId: null,
  updatedAt: "2026-01-02T00:00:00.000Z",
};

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

describe("KanbanCardView GitHub link + diff counts (issue #261)", () => {
  it("renders the card title as a GitHub link when the payload carries a URL", () => {
    const html = renderToString(
      <MemoryRouter>
        <KanbanCardView card={{ ...issueCard(null), url: "https://github.com/o/r/issues/5" }} />
      </MemoryRouter>,
    );
    expect(html).toContain('href="https://github.com/o/r/issues/5"');
    expect(html).toContain("card-title-link");
    expect(html).toContain("Worker-centric diff browsing");
  });

  it("renders a plain title when the payload has no URL (event-derived cards)", () => {
    const html = renderToString(
      <MemoryRouter>
        <KanbanCardView card={issueCard(null)} />
      </MemoryRouter>,
    );
    expect(html).not.toContain("card-title-link");
    expect(html).not.toContain("href=");
  });

  it("renders +/− diff counts on a PR card when the payload resolved them", () => {
    const html = renderToString(
      <MemoryRouter>
        <KanbanCardView card={{ ...prCard, url: "https://github.com/o/r/pull/18", additions: 120, deletions: 3 }} />
      </MemoryRouter>,
    ).replaceAll("<!-- -->", "");
    expect(html).toContain("card-diffstat");
    expect(html).toContain("+120");
    expect(html).toContain("−3");
  });

  it("renders no diff counts when the payload omits them", () => {
    const html = renderToString(
      <MemoryRouter>
        <KanbanCardView card={prCard} />
      </MemoryRouter>,
    );
    expect(html).not.toContain("card-diffstat");
  });

  it("renders no diff counts on an issue card (issues have no diffs)", () => {
    const html = renderToString(
      <MemoryRouter>
        <KanbanCardView card={{ ...issueCard(null), additions: 1, deletions: 1 }} />
      </MemoryRouter>,
    );
    expect(html).not.toContain("card-diffstat");
  });
});
