import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { deriveBoard } from "./kanban";
import { BoardColumn } from "../components/BoardColumn";
import { KanbanCardView } from "../components/KanbanCardView";
import { mockIssues, mockProjects, mockPullRequests, mockWorkers } from "../store/mockData";

const project = mockProjects[0]!;

describe("component render smoke tests", () => {
  it("renders the full board without throwing", () => {
    const board = deriveBoard(project, mockIssues, mockPullRequests, mockWorkers);
    const details = {
      issues: new Map(mockIssues.map((i) => [i.number, i])),
      pullRequests: new Map(mockPullRequests.map((pr) => [pr.number, pr])),
    };
    for (const column of board.columns) {
      const html = renderToString(
        <MemoryRouter>
          <BoardColumn summary={column} details={details} />
        </MemoryRouter>,
      );
      expect(html).toContain("column-label");
    }
  });

  it("renders issue and PR cards with distinct type badges", () => {
    const issueCard = deriveBoard(project, mockIssues, mockPullRequests, mockWorkers).columns[0]!.cards[0]!;
    const issue = mockIssues.find((i) => i.number === issueCard.number)!;
    const issueHtml = renderToString(
      <MemoryRouter>
        <KanbanCardView card={issueCard} detail={issue} />
      </MemoryRouter>,
    );
    expect(issueHtml).toContain("kind-issue");

    const pr = mockPullRequests[0]!;
    const prCard = deriveBoard(project, [], mockPullRequests, mockWorkers).columns
      .flatMap((c) => c.cards)
      .find((c) => c.number === pr.number)!;
    const prHtml = renderToString(
      <MemoryRouter>
        <KanbanCardView card={prCard} detail={pr} />
      </MemoryRouter>,
    );
    expect(prHtml).toContain("kind-pull_request");
    expect(prHtml).toContain("badge-ci");
  });
});
