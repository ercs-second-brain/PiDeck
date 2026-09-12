// @vitest-environment jsdom

/**
 * Component tests for <Sidebar />: the project row surfaces the review
 * account's access failure as a red badge, driven by the reconciler's fact
 * on the project's session views.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, SessionView } from "@pideck/shared";

vi.mock("../lib/api", () => ({ api: vi.fn() }));

import { Sidebar } from "./Sidebar";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT: Project = {
  id: "p1",
  name: "my-api",
  repoUrl: "https://github.com/acme/my-api",
  owner: "acme",
  repo: "my-api",
  defaultBranch: "main",
  path: "/repos/my-api",
};

function view(overrides: { id?: string; persona?: SessionView["session"]["persona"]; projectId?: string | null; reviewAccess?: string | null }): SessionView {
  const id = overrides.id ?? "s1";
  return {
    session: {
      id,
      persona: overrides.persona ?? "orchestrator",
      projectId: overrides.projectId ?? "p1",
      tmuxSession: `tmux-${id}`,
      spawnedAt: "2026-01-01T00:00:00Z",
      model: null,
      lastPromptedHeadSha: null,
      lastDeliveredIssueCommentId: null,
      lastDeliveredPrCommentId: null,
      lastDeliveredReviewId: null,
      lastNotifiedConflictSha: null,
      fixAttempts: 0,
      lastActivityAt: null,
    },
    state: null,
    status: "orchestrator",
    parentSessionId: null,
    title: null,
    reviewAccess: overrides.reviewAccess ?? null,
  };
}

const roots: Root[] = [];

function mountSidebar(sessions: SessionView[]): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <Sidebar
        projects={[PROJECT]}
        sessions={sessions}
        selectedId={null}
        onNavigate={() => {}}
        onChanged={() => {}}
        onToast={() => {}}
      />,
    );
  });
  return container;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
  vi.resetAllMocks();
});

describe("<Sidebar />", () => {
  it("shows a red review-access badge on the project row when the account cannot read the repo", () => {
    const container = mountSidebar([
      view({ id: "w", persona: "worker", reviewAccess: "review account has no access to acme/my-api" }),
      view({ id: "o", persona: "orchestrator" }),
    ]);
    const badge = [...container.querySelectorAll(".badge--red")].find(
      (el) => el.textContent === "review account has no access",
    );
    expect(badge).toBeDefined();
    expect(badge!.closest(".srow")?.textContent).toContain("my-api");
  });

  it("shows no review-access badge when the account can read the repo", () => {
    const container = mountSidebar([view({ id: "o", persona: "orchestrator" })]);
    expect(container.querySelector(".badge--red")).toBeNull();
  });
});