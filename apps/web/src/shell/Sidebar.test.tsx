// @vitest-environment jsdom

/**
 * Component tests for <Sidebar />: the project row surfaces the review
 * account's access failure as a red badge, worker states render as the dot
 * badge, worker/reviewer rows rename from the ⋯ menu, the add-project row
 * sits last styled like every other row, and archived rows keep their real
 * name, dim archived badge, nesting, and selection highlight.
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
  prNumber?: number;
  title?: string | null;
  label?: string;
  state?: SessionView["state"];
  archivedAt?: string;
  parentSessionId?: string | null;
}): SessionView {
  const id = overrides.id ?? "s1";
  return {
    session: {
      id,
      persona: overrides.persona ?? "orchestrator",
      projectId: overrides.projectId ?? "p1",
      issueNumber: overrides.issueNumber,
      prNumber: overrides.prNumber,
      tmuxSession: `tmux-${id}`,
      spawnedAt: "2026-01-01T00:00:00Z",
      model: null,
      label: overrides.label,
      archivedAt: overrides.archivedAt,
      lastPromptedHeadSha: null,
      lastDeliveredIssueCommentId: null,
      lastDeliveredPrCommentId: null,
      lastDeliveredReviewId: null,
      lastNotifiedConflictSha: null,
      lastAddressedHeadSha: null,
      fixAttempts: 0,
      lastActivityAt: null,
    },
    state: overrides.state ?? null,
    status: "orchestrator",
    parentSessionId: overrides.parentSessionId ?? null,
    title: overrides.title ?? null,
    reviewAccess: overrides.reviewAccess ?? null,
  };
}

const roots: Root[] = [];

function mountSidebar(sessions: SessionView[], selectedId: string | null = null): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <Sidebar
        projects={[PROJECT]}
        sessions={sessions}
        selectedId={selectedId}
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

  it("indents the archived group and its rows one level deeper than the live tree", () => {
    const container = mountSidebar([
      view({ id: "w", persona: "worker", issueNumber: 42, title: "Add rate limiting", archivedAt: "2026-01-02T00:00:00Z", state: "done" }),
      view({ id: "live", persona: "worker", issueNumber: 43, title: "Fix flaky test" }),
    ]);
    const toggle = [...container.querySelectorAll(".srow")].find((el) => el.textContent?.includes("Archived (1)"))!;
    const live = [...container.querySelectorAll(".srow")].find((el) => el.querySelector(".srow__num")?.textContent === "#43")!;
    const livePad = live.getAttribute("style")!;
    expect(livePad).toContain("padding-left");
    expect(toggle.getAttribute("style")).toBe(livePad);

    click(toggle);
    const archived = [...container.querySelectorAll(".srow")].find((el) => el.querySelector(".srow__num")?.textContent === "#42")!;
    const deepPad = `padding-left: calc(${10 + 2 * 16}px);`;
    expect(archived.getAttribute("style")).toContain(deepPad);
  });

  it("collapses the archived group by default, counts it in the header, and shows real names inside", () => {
    const container = mountSidebar([
      view({ id: "w", persona: "worker", issueNumber: 42, title: "Add rate limiting", archivedAt: "2026-01-02T00:00:00Z", state: "done" }),
    ]);
    const header = [...container.querySelectorAll(".srow")].find((el) => el.textContent?.includes("Archived (1)"))!;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".srow__num")).toBeNull();

    click(header);
    const row = workerRow(container);
    expect(row.querySelector(".srow__num")?.textContent).toBe("#42");
    expect(row.querySelector(".srow__label")?.textContent).toBe("Add rate limiting");
    expect(row.textContent).not.toContain("archived 2026");
    const dot = row.querySelector(".badge--dot")!;
    expect(dot.classList.contains("badge--dim")).toBe(true);
    expect(dot.getAttribute("title")).toMatch(/^done · archived /);
    expect(dot.getAttribute("aria-label")).toMatch(/^done · archived /);
  });

  it("shows a user-given label on an archived row instead of the issue number and title", () => {
    const container = mountSidebar([
      view({ id: "w", persona: "worker", issueNumber: 42, title: "Add rate limiting", label: "Rate limiting", archivedAt: "2026-01-02T00:00:00Z", state: "done" }),
    ]);
    click([...container.querySelectorAll(".srow")].find((el) => el.textContent?.includes("Archived ("))!);
    const row = [...container.querySelectorAll(".srow")].find((el) => el.textContent?.includes("Rate limiting"))!;
    expect(row.querySelector(".srow__num")).toBeNull();
    expect(row.querySelector(".srow__label")?.textContent).toBe("Rate limiting");
  });

  it("highlights a selected archived row like a selected live row", () => {
    const sessions = [
      view({ id: "w", persona: "worker", issueNumber: 42, title: "Add rate limiting", archivedAt: "2026-01-02T00:00:00Z", state: "done" }),
      view({ id: "live", persona: "worker", issueNumber: 43, title: "Fix flaky test" }),
    ];
    const archivedContainer = mountSidebar(sessions, "w");
    click([...archivedContainer.querySelectorAll(".srow")].find((el) => el.textContent?.includes("Archived ("))!);
    const archivedLine = workerRow(archivedContainer).closest(".srow-line")!;
    expect(archivedLine.hasAttribute("data-selected")).toBe(true);

    const liveContainer = mountSidebar(sessions, "live");
    const liveLine = [...liveContainer.querySelectorAll(".srow-line")].find((el) =>
      el.querySelector(".srow__num")?.textContent === "#43",
    )!;
    expect(liveLine.hasAttribute("data-selected")).toBe(true);
  });

  it("nests an archived reviewer under its archived worker with the ↳ glyph", () => {
    const container = mountSidebar([
      view({ id: "w", persona: "worker", issueNumber: 42, title: "Add rate limiting", archivedAt: "2026-01-02T00:00:00Z", state: "done" }),
      view({ id: "r", persona: "reviewer", prNumber: 99, parentSessionId: "w", title: "Add rate limiting", archivedAt: "2026-01-02T00:00:00Z", state: "done" }),
    ]);
    click([...container.querySelectorAll(".srow")].find((el) => el.textContent?.includes("Archived (2)"))!);
    const rows = [...container.querySelectorAll(".srow-line")].filter((el) => el.querySelector(".srow__num, .srow__glyph"));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector(".srow__num")?.textContent).toBe("#42");
    expect(rows[1]!.querySelector(".srow__glyph")?.textContent).toBe("↳");
  });
});