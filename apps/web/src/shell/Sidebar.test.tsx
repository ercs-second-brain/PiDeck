// @vitest-environment jsdom

/**
 * Component tests for <Sidebar />: the project row surfaces the review
 * account's access failure as a red badge, worker states render as the dot
 * badge, worker/reviewer rows rename from the ⋯ menu, and the add-project
 * row sits last styled like every other row.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, SessionView } from "@pideck/shared";

vi.mock("../lib/api", () => ({ api: vi.fn() }));

import { api } from "../lib/api";
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

function view(overrides: {
  id?: string;
  persona?: SessionView["session"]["persona"];
  projectId?: string | null;
  reviewAccess?: string | null;
  issueNumber?: number;
  title?: string | null;
  label?: string;
  state?: SessionView["state"];
}): SessionView {
  const id = overrides.id ?? "s1";
  return {
    session: {
      id,
      persona: overrides.persona ?? "orchestrator",
      projectId: overrides.projectId ?? "p1",
      issueNumber: overrides.issueNumber,
      tmuxSession: `tmux-${id}`,
      spawnedAt: "2026-01-01T00:00:00Z",
      model: null,
      label: overrides.label,
      lastPromptedHeadSha: null,
      lastDeliveredIssueCommentId: null,
      lastDeliveredPrCommentId: null,
      lastDeliveredReviewId: null,
      lastNotifiedConflictSha: null,
      fixAttempts: 0,
      lastActivityAt: null,
    },
    state: overrides.state ?? null,
    status: "orchestrator",
    parentSessionId: null,
    title: overrides.title ?? null,
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

function openWorkerMenu(container: HTMLElement): void {
  const row = [...container.querySelectorAll(".srow")].find((el) => el.textContent?.includes("#42"))!;
  click(row.parentElement!.querySelector(".srow__menu")!);
}

function click(element: Element): void {
  act(() => {
    (element as HTMLElement).click();
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
  vi.resetAllMocks();
});

function workerRow(container: HTMLElement): HTMLButtonElement {
  return [...container.querySelectorAll(".srow")].find((el) => el.textContent?.includes("#42")) as HTMLButtonElement;
}

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

  it("renders worker state as a coloured dot whose title and aria-label name the state", () => {
    const container = mountSidebar([view({ id: "w", persona: "worker", issueNumber: 42, state: "fixing" })]);
    const dot = workerRow(container).querySelector(".badge--dot")!;
    expect(dot.classList.contains("badge--amber")).toBe(true);
    expect(dot.getAttribute("title")).toBe("fixing");
    expect(dot.getAttribute("aria-label")).toBe("fixing");
  });

  it("shows a user-given label instead of the issue number and title", () => {
    const container = mountSidebar([view({ id: "w", persona: "worker", issueNumber: 42, title: "Add rate limiting", label: "Rate limiting" })]);
    const row = [...container.querySelectorAll(".srow")].find((el) => el.textContent?.includes("Rate limiting"))!;
    expect(row.querySelector(".srow__num")).toBeNull();
    expect(row.querySelector(".srow__label")?.textContent).toBe("Rate limiting");
  });

  it("renames a worker row from its ⋯ menu and persists the label", async () => {
    vi.mocked(api).mockResolvedValue(undefined as never);
    const container = mountSidebar([view({ id: "w", persona: "worker", issueNumber: 42, title: "Add rate limiting" })]);

    openWorkerMenu(container);
    click([...container.querySelectorAll("[role=menuitem]")].find((el) => el.textContent === "Rename…")!);

    const input = container.querySelector<HTMLInputElement>("input.srow__rename")!;
    expect(input.value).toBe("Add rate limiting");
    input.value = "Rate limiting";
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () => {});

    expect(api).toHaveBeenCalledWith("sessionLabel", { id: "w" }, { label: "Rate limiting" });
    expect(container.querySelector("input.srow__rename")).toBeNull();
  });

  it("keeps an empty rename as a cancel", async () => {
    vi.mocked(api).mockResolvedValue(undefined as never);
    const container = mountSidebar([view({ id: "w", persona: "worker", issueNumber: 42, title: "Add rate limiting" })]);

    openWorkerMenu(container);
    click([...container.querySelectorAll("[role=menuitem]")].find((el) => el.textContent === "Rename…")!);

    const input = container.querySelector<HTMLInputElement>("input.srow__rename")!;
    input.value = "  ";
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () => {});

    expect(api).not.toHaveBeenCalled();
    expect(container.querySelector("input.srow__rename")).toBeNull();
  });

  it("puts the add-project row last, styled like the other rows", () => {
    const container = mountSidebar([view({ id: "o", persona: "orchestrator" })]);
    const add = container.querySelector("button.sidebar__add")!;
    expect(add.classList.contains("srow")).toBe(true);
    expect(add.textContent).toBe("+ Add project");
    expect(container.querySelector("nav")!.lastElementChild).toBe(add);
  });
});