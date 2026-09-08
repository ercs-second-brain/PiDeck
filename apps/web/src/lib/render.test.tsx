import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { KanbanBoard, PullRequest, Worker } from "@agentskiss/shared";
import { kanbanBoardSchema, workerSchema } from "@agentskiss/shared";
import { BoardColumn, prKey } from "../components/BoardColumn";
import { BoardColumns, mergedCardDetails } from "../components/BoardColumns";
import { KanbanCardView } from "../components/KanbanCardView";
import { WorkersPanel } from "../components/WorkersPanel";
import { DiffLine } from "../components/DiffView";

const projectId = "demo";

const board: KanbanBoard = kanbanBoardSchema.parse({
  projectId,
  updatedAt: "2026-01-02T00:00:00.000Z",
  columns: [
    {
      column: "backlog",
      cards: [
        {
          id: "issue-1",
          projectId,
          kind: "issue",
          number: 1,
          title: "Fix the thing",
          column: "backlog",
          workerId: null,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    },
    {
      column: "in_progress",
      cards: [
        {
          id: "pr-9",
          projectId,
          kind: "pull_request",
          number: 9,
          title: "fix: the thing",
          column: "in_progress",
          workerId: null,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    },
    { column: "in_review", cards: [] },
    { column: "done", cards: [] },
  ],
});

const pr: PullRequest = {
  projectId,
  number: 9,
  title: "fix: the thing",
  state: "open",
  ciStatus: "success",
  reviewState: "pending",
  headBranch: "ao/w1/root",
  baseBranch: "main",
  author: "bot",
  url: "https://github.com/o/r/pull/9",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("component render smoke tests", () => {
  it("renders the full board without throwing", () => {
    const details = { pullRequests: new Map([[prKey(projectId, pr.number), pr]]) };
    for (const column of board.columns) {
      const html = renderToString(
        <MemoryRouter>
          <BoardColumn summary={column} details={details} />
        </MemoryRouter>,
      );
      expect(html).toContain("column-label");
    }
  });

  it("merges boards into the shared column order for the all-projects view", () => {
    const boardB = kanbanBoardSchema.parse({
      projectId: "other",
      updatedAt: "2026-01-02T00:00:00.000Z",
      columns: [
        { column: "backlog", cards: [] },
        {
          column: "in_progress",
          cards: [
            {
              id: "issue-2",
              projectId: "other",
              kind: "issue",
              number: 3,
              title: "Other project work",
              column: "in_progress",
              workerId: null,
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
          ],
        },
        { column: "in_review", cards: [] },
        { column: "done", cards: [] },
      ],
    });
    const html = renderToString(
      <MemoryRouter>
        <BoardColumns boards={[board, boardB]} details={mergedCardDetails([board, boardB], { [projectId]: [pr] })} />
      </MemoryRouter>,
    );
    // One column set, cards of both boards merged in column order.
    expect(html.match(/class="column column-/g) ?? []).toHaveLength(4);
    expect(html).toContain("Fix the thing");
    expect(html).toContain("Other project work");
    // PR details resolve across the merged boards via the composite key.
    expect(html).toContain("badge-ci");
  });

  it("renders issue and PR cards with distinct type badges and a diff link on open PRs", () => {
    const issueCard = board.columns[0]!.cards[0]!;
    const issueHtml = renderToString(
      <MemoryRouter>
        <KanbanCardView card={issueCard} />
      </MemoryRouter>,
    );
    expect(issueHtml).toContain("kind-issue");
    expect(issueHtml).toContain("badge-open");

    const prCard = board.columns[1]!.cards[0]!;
    const prHtml = renderToString(
      <MemoryRouter>
        <KanbanCardView card={prCard} pr={pr} />
      </MemoryRouter>,
    );
    expect(prHtml).toContain("kind-pull_request");
    expect(prHtml).toContain("badge-ci");
    expect(prHtml).toContain(`/projects/${projectId}/pulls/9`);
  });

  it("renders the workers panel, distinguishing freeform workers", () => {
    const worker: Worker = workerSchema.parse({
      id: "w-free",
      projectId,
      sessionId: "s-free",
      issueNumber: 0,
      prNumber: null,
      status: "running",
      statusMessage: "Freeform task",
      startedAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const html = renderToString(
      <MemoryRouter>
        <WorkersPanel projectId={projectId} workers={[worker]} />
      </MemoryRouter>,
    );
    expect(html).toContain("w-free");
    expect(html).toContain("badge-freeform");
    expect(html).toContain(`/terminal/${worker.sessionId}`);
  });

  it("colors unified diff lines by kind", () => {
    const add = renderToString(<DiffLine line="+added line" />);
    expect(add).toContain("diff-add");
    const del = renderToString(<DiffLine line="-removed line" />);
    expect(del).toContain("diff-del");
    const hunk = renderToString(<DiffLine line="@@ -1,3 +1,4 @@" />);
    expect(hunk).toContain("diff-hunk");
    const header = renderToString(<DiffLine line="diff --git a/x b/x" />);
    expect(header).toContain("diff-file-header");
    const context = renderToString(<DiffLine line="unchanged" />);
    expect(context).toContain("diff-context");
  });
});
