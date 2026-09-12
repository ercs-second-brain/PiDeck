import { describe, expect, it } from "vitest";
import type { Project, SessionView } from "@pideck/shared";
import { buildTree, githubLinks, rowText, sessionRow } from "./tree";

function project(id: string, name: string): Project {
  return {
    id,
    name,
    repoUrl: `https://github.com/acme/${name}`,
    owner: "acme",
    repo: name,
    defaultBranch: "main",
    path: `/repos/${name}`,
  };
}

let nextId = 0;

function view(overrides: {
  id?: string;
  persona?: SessionView["session"]["persona"];
  projectId?: string | null;
  issueNumber?: number;
  prNumber?: number;
  archivedAt?: string;
  parentSessionId?: string | null;
  status?: string;
  state?: SessionView["state"];
  spawnedAt?: string;
}): SessionView {
  const id = overrides.id ?? `s${++nextId}`;
  return {
    session: {
      id,
      persona: overrides.persona ?? "worker",
      projectId: overrides.projectId ?? null,
      issueNumber: overrides.issueNumber,
      prNumber: overrides.prNumber,
      tmuxSession: `tmux-${id}`,
      spawnedAt: overrides.spawnedAt ?? "2026-01-01T00:00:00Z",
      model: null,
      archivedAt: overrides.archivedAt,
      lastPromptedHeadSha: null,
      lastDeliveredIssueCommentId: null,
      lastDeliveredPrCommentId: null,
      lastDeliveredReviewId: null,
      fixAttempts: 0,
      lastActivityAt: null,
    },
    state: overrides.state ?? null,
    status: overrides.status ?? "",
    parentSessionId: overrides.parentSessionId ?? null,
  };
}

describe("buildTree", () => {
  it("puts the global agent on top, outside any project", () => {
    const tree = buildTree([], [view({ id: "g", persona: "global" })]);
    expect(tree.globalAgent?.session.id).toBe("g");
    expect(tree.projects).toHaveLength(0);
  });

  it("prefers the live global agent over an archived one", () => {
    const archived = view({ id: "old", persona: "global", archivedAt: "2026-01-02T00:00:00Z" });
    const live = view({ id: "new", persona: "global" });
    const tree = buildTree([], [archived, live]);
    expect(tree.globalAgent?.session.id).toBe("new");
  });

  it("groups orchestrator, workers in issue order, and reviewers under their worker", () => {
    const p = project("p1", "my-api");
    const orch = view({ id: "o", persona: "orchestrator", projectId: "p1" });
    const w47 = view({ id: "w47", projectId: "p1", issueNumber: 47, status: "Fix flaky test" });
    const w42 = view({ id: "w42", projectId: "p1", issueNumber: 42, status: "Add rate limiting", prNumber: 99 });
    const rev = view({
      id: "r",
      persona: "reviewer",
      projectId: "p1",
      prNumber: 99,
      parentSessionId: "w42",
      status: "reviewing PR #99",
      state: "in_review",
    });
    const tree = buildTree([p], [w47, rev, orch, w42]);
    const node = tree.projects[0];
    expect(node?.orchestrator?.session.id).toBe("o");
    expect(node?.workers.map((worker) => worker.view.session.id)).toEqual(["w42", "w47"]);
    expect(node?.workers[0]?.reviewers.map((r) => r.session.id)).toEqual(["r"]);
    expect(node?.workers[1]?.reviewers).toHaveLength(0);
  });

  it("moves archived sessions out of the live tree into the project's archived group", () => {
    const p = project("p1", "my-api");
    const done = view({
      id: "w1",
      projectId: "p1",
      issueNumber: 42,
      archivedAt: "2026-01-02T00:00:00Z",
      state: "done",
    });
    const liveWorker = view({ id: "w2", projectId: "p1", issueNumber: 43 });
    const tree = buildTree([p], [done, liveWorker]);
    const node = tree.projects[0];
    expect(node?.workers.map((worker) => worker.view.session.id)).toEqual(["w2"]);
    expect(node?.archived.map((v) => v.session.id)).toEqual(["w1"]);
  });

  it("sorts archived sessions newest first", () => {
    const p = project("p1", "my-api");
    const older = view({ id: "a", projectId: "p1", archivedAt: "2026-01-02T00:00:00Z" });
    const newer = view({ id: "b", projectId: "p1", archivedAt: "2026-01-03T00:00:00Z" });
    const tree = buildTree([p], [older, newer]);
    expect(tree.projects[0]?.archived.map((v) => v.session.id)).toEqual(["b", "a"]);
  });

  it("ignores sessions for unknown projects and drops reviewers whose worker is gone", () => {
    const p = project("p1", "my-api");
    const orphan = view({ id: "r", persona: "reviewer", projectId: "p1", parentSessionId: "gone" });
    const stray = view({ id: "x", projectId: "nope" });
    const tree = buildTree([p], [orphan, stray]);
    const node = tree.projects[0];
    expect(node?.workers).toHaveLength(0);
    expect(node?.archived).toHaveLength(0);
  });

  it("keeps project order and yields empty nodes for projectless projects", () => {
    const first = project("p1", "my-api");
    const second = project("p2", "my-web");
    const tree = buildTree([first, second], []);
    expect(tree.projects.map((node) => node.project.name)).toEqual(["my-api", "my-web"]);
    expect(tree.projects[0]?.workers).toHaveLength(0);
    expect(tree.projects[0]?.orchestrator).toBeNull();
  });
});

describe("sessionRow / rowText", () => {
  it("renders workers as a blue issue number plus the one-line status", () => {
    const row = sessionRow(view({ id: "w", issueNumber: 42, status: "Add rate limiting" }));
    expect(row).toEqual({ num: "#42", glyph: null, label: "Add rate limiting" });
    expect(rowText(view({ id: "w", issueNumber: 42, status: "Add rate limiting" }))).toBe("#42 Add rate limiting");
  });

  it("marks reviewers with the ↳ glyph and falls back to 'Reviewer'", () => {
    expect(sessionRow(view({ id: "r", persona: "reviewer" }))).toEqual({
      num: null,
      glyph: "↳",
      label: "Reviewer",
    });
    expect(sessionRow(view({ id: "r2", persona: "reviewer", status: "reviewing" })).label).toBe("reviewing");
  });

  it("labels the global agent and the orchestrator", () => {
    expect(sessionRow(view({ id: "g", persona: "global" })).label).toBe("Global agent");
    expect(sessionRow(view({ id: "o", persona: "orchestrator" })).label).toBe("Orchestrator");
  });
});

describe("githubLinks", () => {
  it("links the issue and the PR, in that order", () => {
    const p = project("p1", "my-api");
    const links = githubLinks(p, view({ id: "w", issueNumber: 42, prNumber: 99 }));
    expect(links).toEqual([
      { label: "Open issue #42", url: "https://github.com/acme/my-api/issues/42" },
      { label: "Open PR #99", url: "https://github.com/acme/my-api/pull/99" },
    ]);
  });

  it("returns nothing for sessions without issue or PR", () => {
    expect(githubLinks(project("p1", "my-api"), view({ id: "o", persona: "orchestrator" }))).toEqual([]);
  });
});
