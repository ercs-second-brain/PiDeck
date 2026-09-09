/**
 * Tests for the preset-prompt agent-kind session rows in the sidebar
 * (docs/agent-kinds.md, issues #297/#300/#302): agent sessions render with
 * their kind as the badge, NESTED under their caller per the #187
 * child-group pattern (menu spawns — parented to the orchestrator — sit at
 * the project's child level; worker spawns nest under the worker's row),
 * and they are attachable like worker rows. The picker is pure, so it is
 * exercised directly without xterm or effects.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { Session } from "@pideck/shared";
import { SessionPicker, type ProjectEntry } from "./SessionPicker";
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
/** Worker-spawned investigator: parent is the worker session. */
const investigator = makeSession({ id: "sess-agent-2", agentKind: "investigator", parentSessionId: worker.id, tmuxSession: "agentskiss-investigate" });

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
    />,
  );
}

describe("agent-kind session rows (docs/agent-kinds.md, #297/#300/#302)", () => {
  it("renders menu-spawned audit sessions at the project's child level with their kind badge", () => {
    const html = renderPicker([entryWith([orchestrator, worker, devexAudit])]);
    expect(html).toContain("role-agent");
    expect(html).toContain(">devex-audit</span>");
    // Sidebar label: the spawn's Session.name, with the tmux name as fallback.
    expect(html).toContain("agentskiss-devex-audit");
    expect(html).toContain("picker-workers");
    expect(html).not.toContain("picker-agent-children");
  });

  it("falls back to the tmux session name when the spawn carries no sidebar label", () => {
    const unlabeled = makeSession({ id: "sess-agent-4", agentKind: "kiss-audit", parentSessionId: orchestrator.id, tmuxSession: "agentskiss-kiss-audit" });
    const html = renderPicker([entryWith([orchestrator, unlabeled])]);
    expect(html).toContain("agentskiss-kiss-audit");
  });

  it("nests worker-spawned agent sessions under their caller's row (#187 child-group pattern)", () => {
    const html = renderPicker([entryWith([orchestrator, worker, investigator])]);
    expect(html).toContain("picker-agent-children");
    expect(html).toContain(">investigator</span>");
    expect(html).toContain("agentskiss-investigate");
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

  it("hides agent sessions with the project's collapsed children (issue #114)", () => {
    const entry = entryWith([orchestrator, worker, investigator]);
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
    expect(html).not.toContain("agentskiss-investigate");
  });
});
