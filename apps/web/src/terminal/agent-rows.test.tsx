/**
 * Tests for the preset-prompt agent-kind session rows in the sidebar
 * (docs/agent-kinds.md, issues #297/#300/#302): agent sessions render with
 * their kind as the badge, NESTED under their caller per the #187
 * child-group pattern (menu spawns — parented to the orchestrator — sit at
 * the project's child level; worker spawns nest under the worker's row),
 * and they are attachable like worker rows. Issue #311: every agent row —
 * nested or not — also carries the terminate affordance confirmed through
 * the #268 modal pattern; issue #355 (B5) moves it behind the row's ⋯
 * context menu. The picker is pure, so it is
 * exercised directly without xterm or effects.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { Session } from "@pideck/shared";
import { SessionPicker, type ProjectEntry } from "./SessionPicker";
import { RowOptionsMenu } from "./picker-rows";
import { TerminateAgentSessionModal } from "./picker-modals";
import { makeProject } from "./test-fixtures";

const project = makeProject();

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-x",
    projectId: project.id,
    role: "worker",
    tmuxSession: "agentskiss-agent",
    workerId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const orchestrator = makeSession({ id: "sess-orch-1", role: "orchestrator", tmuxSession: "agentskiss-orchestrator" });
const worker = makeSession({ id: "sess-worker-1", tmuxSession: "agentskiss-worker-a", workerId: "worker-1" });

/** Menu-spawned audits: parent is the project orchestrator (by construction). */
const devexAudit = makeSession({ id: "sess-agent-1", agentKind: "devex-audit", parentSessionId: orchestrator.id, tmuxSession: "agentskiss-devex-audit", name: "devex-audit" });
/** Worker-spawned researcher: parent is the worker session. */
const researcher = makeSession({ id: "sess-agent-2", agentKind: "researcher", parentSessionId: worker.id, tmuxSession: "agentskiss-research" });

function entryWith(sessions: Session[]): ProjectEntry {
  return { project, sessions, workers: [] };
}

function renderPicker(entries: ProjectEntry[], overrides: Partial<Parameters<typeof SessionPicker>[0]> = {}): string {
  return renderToString(
    <SessionPicker
      entries={entries}
      error={null}
      selectedSessionId={overrides.selectedSessionId ?? null}
      onSelectSession={() => {}}
      onSelectProject={() => {}}
      onOpenSettings={() => {}}
      onSelectAllProjects={() => {}}
      onStartOnboarding={() => {}}
      onOpenGlobalSettings={() => {}}
      onStartOrchestrator={() => {}}
      onSpawnAgentSession={overrides.onSpawnAgentSession}
      onTerminateAgentSession={overrides.onTerminateAgentSession}
    />,
  );
}

describe("agent-kind session rows (docs/agent-kinds.md, #297/#300/#302)", () => {
  it("renders menu-spawned audit sessions at the project's child level with their kind badge", () => {
    const html = renderPicker([entryWith([orchestrator, devexAudit])]);
    expect(html).toContain("role-agent");
    // Sidebar label: the spawn's Session.name (its tmux name is fallback —
    // and, per issue #316, the persona no longer double-renders as a ghost
    // "worker" row that would carry the tmux name).
    expect(html).toContain(">devex-audit</span>");
    expect(html).toContain("picker-workers");
    expect(html).not.toContain("picker-agent-children");
  });

  it("falls back to the tmux session name when the spawn carries no sidebar label", () => {
    const unlabeled = makeSession({ id: "sess-agent-4", agentKind: "kiss-audit", parentSessionId: orchestrator.id, tmuxSession: "agentskiss-kiss-audit" });
    const html = renderPicker([entryWith([orchestrator, unlabeled])]);
    expect(html).toContain("agentskiss-kiss-audit");
  });

  // Issue #316: agent-kind sessions carry role "worker" in the registry —
  // the worker-row filter must exclude them, or every persona spawn drew a
  // ghost "worker" row alongside its agent row.
  it("shows exactly one row per persona spawn — no ghost worker row (issue #316)", () => {
    const html = renderPicker([entryWith([orchestrator, devexAudit])]);
    expect(html).toContain(">devex-audit</span>");
    expect(html).not.toContain("role-worker");
    expect(html).not.toContain("picker-agent-children");
  });

  it("does not double-render worker-spawned personas as worker rows (issue #316)", () => {
    const html = renderPicker([entryWith([orchestrator, worker, researcher])]);
    expect(html).toContain("picker-agent-children");
    // Exactly one worker row (the real worker) and one row for the persona.
    expect(html.match(/role-worker/g)?.length).toBe(1);
    expect(html.match(/agentskiss-research/g)?.length).toBe(1);
  });

  it("nests worker-spawned agent sessions under their caller's row (#187 child-group pattern)", () => {
    const html = renderPicker([entryWith([orchestrator, worker, researcher])]);
    expect(html).toContain("picker-agent-children");
    expect(html).toContain(">researcher</span>");
    expect(html).toContain("agentskiss-research");
    // The nested group renders inside the caller's worker row.
    expect(html.indexOf("sess-worker-1")).toBeLessThan(html.indexOf("picker-agent-children"));
  });

  it("falls back to the project child level when the caller's session is not in the group", () => {
    const orphan = makeSession({ id: "sess-agent-3", agentKind: "kiss-audit", parentSessionId: "sess-gone", tmuxSession: "agentskiss-kiss-audit" });
    const html = renderPicker([entryWith([orchestrator, orphan])]);
    expect(html).toContain(">kiss-audit</span>");
    expect(html).not.toContain("picker-agent-children");
  });

  it("renders agent rows as attachable session buttons", () => {
    const html = renderPicker([entryWith([orchestrator, devexAudit])], { selectedSessionId: devexAudit.id });
    expect(html).toContain("picker-session selected");
    expect(html).toContain("Attach the devex-audit session&#x27;s terminal");
  });

  // Issue #316: selection keys on the session id, and the persona renders
  // only through its agent row — exactly one selected row, never the ghost
  // pair the worker-filter double-render produced.
  it("selects the persona row alone — no joint selection (issue #316)", () => {
    const html = renderPicker([entryWith([orchestrator, devexAudit])], { selectedSessionId: devexAudit.id });
    expect(html.match(/picker-session selected/g)?.length).toBe(1);
  });

  it("hides agent sessions with the project's collapsed children (issue #114)", () => {
    const entry = entryWith([orchestrator, worker, researcher]);
    const html = renderToString(
      <SessionPicker
        entries={[entry]}
        error={null}
        selectedSessionId={null}
        defaultCollapsedProjects={new Set([project.id])}
        onSelectSession={() => {}}
        onSelectProject={() => {}}
        onOpenSettings={() => {}}
        onSelectAllProjects={() => {}}
        onStartOnboarding={() => {}}
        onOpenGlobalSettings={() => {}}
        onStartOrchestrator={() => {}}
      />,
    );
    expect(html).not.toContain("agentskiss-research");
  });
});

describe("agent-row ⋯ terminate menu (issue #355, B5 — #311 affordance moved off the row, #268 modal pattern)", () => {
  it("renders the ⋯ affordance on root-level agent rows when a terminate handler is wired", () => {
    const html = renderPicker([entryWith([orchestrator, devexAudit])], { onTerminateAgentSession: async () => {} });
    expect(html).toContain("picker-row-menu-toggle");
    expect(html).toContain('title="Session options"');
    // The standalone ✕ delete button is gone from the row (issue #355, B5).
    expect(html).not.toContain("picker-terminate");
    expect(html.indexOf("sess-agent-1")).toBeLessThan(html.indexOf("picker-row-menu-toggle"));
  });

  it("renders the ⋯ affordance on nested agent rows too (nested or not, per #311/#355)", () => {
    const html = renderPicker([entryWith([orchestrator, worker, researcher])], { onTerminateAgentSession: async () => {} });
    expect(html).toContain("picker-agent-children");
    expect(html).toContain("picker-row-menu-toggle");
  });

  it("omits the affordance without a terminate handler (legacy hosts/tests)", () => {
    const html = renderPicker([entryWith([orchestrator, devexAudit])]);
    expect(html).not.toContain("picker-row-menu-toggle");
  });

  it("RowOptionsMenu renders its menu with the danger Terminate entry when open", () => {
    const open = renderToString(
      <RowOptionsMenu sessionId="s" open pending entryLabel="Terminate session…" entryTitle="t" onToggle={() => {}} onAskTerminate={() => {}} />,
    );
    expect(open).toContain("picker-row-menu");
    expect(open).toContain("picker-menu-danger");
    expect(open).toContain("Terminate session…");
    // In-flight overlay: the entry is disabled while the request runs.
    expect(open).toContain("disabled");
  });

  it("renders the agent terminate modal with label, kind, and no-archived-log copy", () => {
    const html = renderToString(
      <TerminateAgentSessionModal
        sessionLabel="devex-audit"
        agentKind="devex-audit"
        pending={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("Terminate session?");
    expect(html).toContain("<code>devex-audit</code>");
    expect(html).toContain("keep no archived log");
    expect(html).toContain(">Terminate</button>");
  });

  it("shows the in-flight and failure states inside the agent terminate modal", () => {
    const pending = renderToString(
      <TerminateAgentSessionModal sessionLabel="x" agentKind="kiss-audit" pending onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(pending).toContain("Terminating…");
    const failed = renderToString(
      <TerminateAgentSessionModal sessionLabel="x" agentKind="kiss-audit" pending={false} error="no route for POST" onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(failed).toContain("terminate-modal-error");
    expect(failed).toContain("no route for POST");
  });
});

