/**
 * Reviewer-session nesting in the sidebar (issue #502): a reviewer worker
 * spawned to review a PR must render indented as a child of the worker that
 * authored the PR (the #187 child-group pattern, keyed through
 * `Worker.parentWorkerId` — the daemon payload already carries the
 * linkage; see agent-nesting.tsx `splitWorkerSessions`). The picker is
 * pure, so it is exercised directly without xterm or effects.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { Session, Worker } from "@pideck/shared";
import { SessionPicker, type ProjectEntry } from "./SessionPicker";
import { splitWorkerSessions } from "./agent-nesting";
import { makeProject, makeSession, makeWorker } from "./test-fixtures";

const project = makeProject();

const orchestrator = makeSession({ id: "sess-orch-1", role: "orchestrator", tmuxSession: "agentskiss-orchestrator" });
const implementerSession = makeSession({ id: "sess-impl-1", tmuxSession: "agentskiss-worker-impl", workerId: "worker-impl" });
const implementer = makeWorker({ id: "worker-impl", sessionId: "sess-impl-1", prNumbers: [502] });
const reviewerSession = makeSession({ id: "sess-review-1", tmuxSession: "agentskiss-reviewer-1", workerId: "worker-review" });
const reviewer = makeWorker({ id: "worker-review", sessionId: "sess-review-1", kind: "reviewer", parentWorkerId: "worker-impl", prNumbers: [502] });

function entryWith(sessions: Session[], workers: Worker[]): ProjectEntry {
  return { project, sessions, workers };
}

function renderPicker(entries: ProjectEntry[]): string {
  return renderToString(
    <SessionPicker
      entries={entries}
      error={null}
      selectedSessionId={null}
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

describe("reviewer worker nesting (issue #502)", () => {
  it("nests a spawned reviewer under the PR-authoring worker's row", () => {
    const html = renderPicker([entryWith([orchestrator, implementerSession, reviewerSession], [implementer, reviewer])]);
    // The reviewer row renders inside the implementer's nested child group.
    expect(html).toContain("picker-agent-children");
    expect(html).toContain("agentskiss-reviewer-1");
    expect(html.indexOf("agentskiss-worker-impl")).toBeLessThan(html.indexOf("picker-agent-children"));
    expect(html.indexOf("picker-agent-children")).toBeLessThan(html.indexOf("agentskiss-reviewer-1"));
  });

  it("badges the nested reviewer row as a reviewer", () => {
    const html = renderPicker([entryWith([orchestrator, implementerSession, reviewerSession], [implementer, reviewer])]);
    expect(html).toContain("role-reviewer");
  });

  it("keeps the reviewer at the root level when the daemon carries no parent linkage (older records)", () => {
    const unlinked = makeWorker({ id: "worker-review", sessionId: "sess-review-1", kind: "reviewer" });
    const html = renderPicker([entryWith([orchestrator, implementerSession, reviewerSession], [implementer, unlinked])]);
    expect(html).not.toContain("picker-agent-children");
    expect(html).toContain("agentskiss-reviewer-1");
  });

  it("keeps the reviewer visible at the root level when its parent worker is archived", () => {
    const archivedImpl = makeWorker({ id: "worker-impl", sessionId: "sess-impl-1", status: "archived" });
    const html = renderPicker([entryWith([orchestrator, implementerSession, reviewerSession], [archivedImpl, reviewer])]);
    // The archived implementer sits in the Archived section; the live
    // reviewer must not disappear — it renders at the root level.
    expect(html).toContain("picker-archived");
    expect(html).toContain("agentskiss-reviewer-1");
    expect(html.indexOf("agentskiss-reviewer-1")).toBeLessThan(html.indexOf("picker-archived"));
  });

  it("renders an archived reviewer exactly once, flat in the Archived section", () => {
    const archivedReviewerSession = makeSession({ id: "sess-review-1", tmuxSession: "agentskiss-reviewer-1", workerId: "worker-review" });
    const archivedReviewer = makeWorker({ id: "worker-review", sessionId: "sess-review-1", kind: "reviewer", parentWorkerId: "worker-impl", status: "archived" });
    const html = renderToString(
      <SessionPicker
        entries={[entryWith([orchestrator, implementerSession, archivedReviewerSession], [implementer, archivedReviewer])]}
        error={null}
        selectedSessionId={null}
        defaultArchivedOpen
        onSelectSession={() => {}}
        onSelectProject={() => {}}
        onOpenSettings={() => {}}
        onSelectAllProjects={() => {}}
        onStartOnboarding={() => {}}
        onOpenGlobalSettings={() => {}}
        onStartOrchestrator={() => {}}
      />,
    );
    expect(html.match(/agentskiss-reviewer-1/g)?.length).toBe(1);
    // Flat: the archived reviewer does not nest (no child-group markup).
    expect(html).not.toContain("picker-agent-children");
  });

  it("renders the ⋯ terminate affordance on the nested reviewer row", () => {
    const html = renderToString(
      <SessionPicker
        entries={[entryWith([orchestrator, implementerSession, reviewerSession], [implementer, reviewer])]}
        error={null}
        selectedSessionId={null}
        onSelectSession={() => {}}
        onSelectProject={() => {}}
        onOpenSettings={() => {}}
        onSelectAllProjects={() => {}}
        onStartOnboarding={() => {}}
        onOpenGlobalSettings={() => {}}
        onStartOrchestrator={() => {}}
        onTerminateWorker={async () => {}}
      />,
    );
    // Two wired worker rows (implementer + nested reviewer), each with a ⋯ menu.
    expect(html.match(/picker-row-menu-toggle/g)?.length).toBe(2);
  });
});

describe("splitWorkerSessions (issue #502 grouping)", () => {
  it("groups reviewer sessions under their parent session id, preserving session order", () => {
    const secondReviewer = makeSession({ id: "sess-review-2", workerId: "worker-review-2" });
    const secondReviewerWorker = makeWorker({ id: "worker-review-2", sessionId: "sess-review-2", kind: "reviewer", parentWorkerId: "worker-impl" });
    const { rootWorkers, nestedWorkersByParent } = splitWorkerSessions(
      [implementerSession, reviewerSession, secondReviewer],
      [implementer, reviewer, secondReviewerWorker],
    );
    expect(rootWorkers).toEqual([implementerSession]);
    expect(nestedWorkersByParent.get("sess-impl-1")).toEqual([reviewerSession, secondReviewer]);
  });

  it("falls back to the root level when the parent session is not in the group", () => {
    const orphan = makeSession({ id: "sess-review-1", workerId: "worker-review" });
    const { rootWorkers, nestedWorkersByParent } = splitWorkerSessions([orchestrator, orphan], [reviewer]);
    expect(rootWorkers).toEqual([orchestrator, orphan]);
    expect(nestedWorkersByParent.size).toBe(0);
  });

  it("never loses rows to a malformed parent cycle — cycle members render at the root", () => {
    const workerA = makeWorker({ id: "worker-a", sessionId: "sess-a", parentWorkerId: "worker-b" });
    const workerB = makeWorker({ id: "worker-b", sessionId: "sess-b", parentWorkerId: "worker-a" });
    const sessionA = makeSession({ id: "sess-a", workerId: "worker-a" });
    const sessionB = makeSession({ id: "sess-b", workerId: "worker-b" });
    const { rootWorkers, nestedWorkersByParent } = splitWorkerSessions([sessionA, sessionB], [workerA, workerB]);
    expect(rootWorkers).toEqual([sessionA, sessionB]);
    expect(nestedWorkersByParent.size).toBe(0);
  });
});