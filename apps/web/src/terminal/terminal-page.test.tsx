/**
 * Tests for the terminal sidebar (SessionPicker, issue #62): the "Workspace"
 * row and "+ Add project" bottom row (issue #259), per-project IA (the
 * project name opens the kanban board and the chat icon attaches/starts
 * the orchestrator, issue #173; workers nested beneath, start affordance
 * when absent), role/worker badges, selection state, and empty/error
 * handling. The sidebar is pure, so it is exercised directly without xterm
 * or effects.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { Session, Worker } from "@pideck/shared";
import { makeProject, makeSession, makeWorker } from "./test-fixtures";
import { SessionPicker } from "./SessionPicker";
import { RowOptionsMenu } from "./picker-rows";
import { TerminateWorkerModal } from "./picker-modals";

const project = makeProject();

const sessions: Session[] = [
  makeSession({ id: "sess-orch-1", role: "orchestrator", tmuxSession: "pideck-agentskiss-orchestrator-1" }),
  makeSession({ workerId: "worker-1" }),
];

const workers: Worker[] = [makeWorker()];

type PickerProps = Parameters<typeof SessionPicker>[0];

function renderPicker(overrides: Partial<PickerProps> = {}) {
  return renderToString(
    <SessionPicker
      entries={overrides.entries ?? [{ project, sessions, workers }]}
      error={overrides.error ?? null}
      loading={overrides.loading}
      selectedSessionId={overrides.selectedSessionId ?? null}
      selectedProjectId={overrides.selectedProjectId}
      startingProjectId={overrides.startingProjectId}
      terminatingWorkerId={overrides.terminatingWorkerId}
      defaultArchivedOpen={overrides.defaultArchivedOpen}
      defaultCollapsedProjects={overrides.defaultCollapsedProjects}
      onSelectSession={overrides.onSelectSession ?? (() => {})}
      onSelectProject={overrides.onSelectProject ?? (() => {})}
      onOpenSettings={overrides.onOpenSettings ?? (() => {})}
      onSelectAllProjects={overrides.onSelectAllProjects ?? (() => {})}
      onOpenGlobalSettings={overrides.onOpenGlobalSettings ?? (() => {})}
      onStartOnboarding={overrides.onStartOnboarding ?? (() => {})}
      onStartOrchestrator={overrides.onStartOrchestrator ?? (() => {})}
      onTerminateWorker={overrides.onTerminateWorker}
    />,
  );
}

describe("SessionPicker", () => {
  it("renders the Workspace row and the + Add project bottom row", () => {
    const html = renderPicker();
    // Issue #259: the Workspace row (name = all-projects board entry) and
    // the add-project row (the former header "+") replace the old header.
    expect(html).toContain("title=\"Open the workspace board\"");
    expect(html).toContain("title=\"Connect a project\"");
    expect(html).toContain("+ Add project");
    expect(html).not.toContain("picker-header");
  });

  it("renders the project name as the kanban entry with a chat icon (issue #173)", () => {
    const html = renderPicker();
    expect(html).toContain("picker-project-row");
    expect(html).toContain("picker-project-name");
    expect(html).toContain("agentsKISS");
    // Issue #173: the row icon is a chat bubble attaching/starting the
    // orchestrator's pi terminal (the #53 affordance).
    expect(html).toContain("picker-project-chat");
    expect(html).toContain("Attach agentsKISS&#x27;s orchestrator terminal");
    expect(html).toContain("Open agentsKISS&#x27;s kanban board");
  });

  it("lists worker sessions with role badges; the orchestrator row is gone (issue #108)", () => {
    const html = renderPicker();
    expect(html).toContain("role-worker");
    expect(html).toContain("pideck-agentskiss-worker-1");
    // Issue #108: no separate orchestrator row — the project name is the entry.
    expect(html).not.toContain("pideck-agentskiss-orchestrator-1");
    expect(html).not.toContain("role-orchestrator");
  });

  it("nests workers beneath the project row (issue #63)", () => {
    const html = renderPicker();
    const project = html.indexOf("agentsKISS");
    const worker = html.indexOf("pideck-agentskiss-worker-1");
    expect(project).toBeLessThan(worker);
    // The worker list is a tree-indented list under the project row.
    expect(html).toContain("picker-workers");
    expect(html).toContain("picker-worker-row");
  });

  it("renders the archived section as an indented child group after the workers (issue #174)", () => {
    const archivedWorker: Worker = { ...workers[0]!, id: "worker-2", status: "archived" };
    const secondWorkerSession: Session = { ...sessions[1]!, id: "sess-worker-2", tmuxSession: "pideck-agentskiss-worker-2", workerId: "worker-2" };
    const html = renderPicker({
      entries: [{ project, sessions: [...sessions, secondWorkerSession], workers: [...workers, archivedWorker] }],
      defaultArchivedOpen: true,
    });
    // Hierarchy within one project section: row → workers → archived group.
    const row = html.indexOf("picker-project-row");
    const live = html.indexOf("picker-workers");
    const archived = html.indexOf("picker-archived");
    expect(row).toBeLessThan(live);
    expect(live).toBeLessThan(archived);
    // All three stay inside the same project section — the archived group is
    // a child of the project, not a sibling section.
    const sectionEnd = html.indexOf("</section>");
    expect(archived).toBeLessThan(sectionEnd);
    // Archived rows render inside the archived group's own list.
    const archivedList = html.indexOf("picker-archived-list");
    expect(archivedList).toBeLessThan(html.indexOf("pideck-agentskiss-worker-2"));
  });

  it("keeps worker status badges and selection on indented worker rows (issue #63)", () => {
    const html = renderPicker({ selectedSessionId: "sess-worker-1" });
    // Worker rows keep the live status badge and the selected class.
    expect(html).toContain("status-indicator-working");
    expect(html).toContain("picker-session selected");
    expect(html).toContain("role-worker");
  });

  it("uses the chat icon to start the orchestrator when absent (issue #173)", () => {
    const withoutOrchestrator = renderPicker({
      entries: [{ project, sessions: sessions.filter((s) => s.role === "worker"), workers }],
    });
    expect(withoutOrchestrator).not.toContain("picker-start-orchestrator");
    expect(withoutOrchestrator).toContain("Start agentsKISS&#x27;s orchestrator");
  });

  it("offers the orchestrator start through the chat icon for projects with no sessions", () => {
    const html = renderPicker({ entries: [{ project, sessions: [], workers: [] }] });
    expect(html).toContain("Start agentsKISS&#x27;s orchestrator");
    expect(html).not.toContain("No active sessions.");
  });

  it("shows the no-projects empty state pointing at the add-project row", () => {
    const html = renderPicker({ entries: [] });
    expect(html).toContain("No projects yet");
  });

  it("shows a loading state instead of the empty state while the project list loads (issue #90)", () => {
    const html = renderPicker({ entries: [], loading: true });
    expect(html).toContain("Loading projects…");
    expect(html).not.toContain("No projects yet");
  });

  it("shows the daemon-unreachable error state", () => {
    const html = renderPicker({ entries: [], error: "connection refused" });
    expect(html).toContain("Daemon unreachable");
    expect(html).toContain("connection refused");
  });
});

describe("SessionPicker (selection, issue #173)", () => {
  it("marks the attached session and the open board", () => {
    const html = renderPicker({ selectedSessionId: "sess-worker-1" });
    expect(html.match(/picker-session selected/g)).toHaveLength(1);
    const board = renderPicker({ selectedProjectId: project.id });
    expect(board).toContain("picker-project-name selected");
    expect(board).toContain("picker-project-chat");
  });

  it("marks the chat icon selected while the orchestrator is attached, pending while starting", () => {
    const attached = renderPicker({ selectedSessionId: "sess-orch-1" });
    expect(attached).toContain("picker-project-chat selected");
    const starting = renderPicker({ entries: [{ project, sessions: [], workers: [] }], startingProjectId: project.id });
    expect(starting).toContain("picker-project-chat pending");
    expect(starting).toContain("disabled");
  });
});

describe("SessionPicker (collapsible projects, issue #114)", () => {
  it("renders a chevron per project row, expanded by default", () => {
    const html = renderPicker();
    expect(html).toContain("picker-project-chevron");
    expect(html).toContain("▾");
    expect(html).toContain('aria-expanded="true"');
    // Default expanded: children visible.
    expect(html).toContain("pideck-agentskiss-worker-1");
  });

  it("hides all children (workers + archived section) when collapsed", () => {
    const archivedWorker: Worker = { ...workers[0]!, id: "worker-2", status: "archived" };
    const secondWorkerSession: Session = { ...sessions[1]!, id: "sess-worker-2", tmuxSession: "pideck-agentskiss-worker-2", workerId: "worker-2" };
    const html = renderPicker({
      entries: [{ project, sessions: [...sessions, secondWorkerSession], workers: [...workers, archivedWorker] }],
      defaultCollapsedProjects: new Set([project.id]),
    });
    expect(html).toContain("▸");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("pideck-agentskiss-worker-1");
    expect(html).not.toContain("pideck-agentskiss-worker-2");
    expect(html).not.toContain("picker-archived");
  });

  it("keeps the project row itself (name + chat icon) visible when collapsed", () => {
    const html = renderPicker({ defaultCollapsedProjects: new Set([project.id]) });
    expect(html).toContain("agentsKISS");
    expect(html).toContain("picker-project-chat");
  });
});

describe("SessionPicker (worker status indicators, issue #112)", () => {
  it("shows the working tone with a slow pulse on running workers", () => {
    const html = renderPicker();
    expect(html).toContain("status-indicator-working");
    expect(html).toContain("status-indicator-pulse");
    expect(html).toContain("running");
  });

  it("maps the other worker states to the indicator scheme", () => {
    const prUp = renderPicker({
      entries: [{ project, sessions, workers: [{ ...workers[0]!, status: "awaiting_ci" }] }],
    });
    expect(prUp).toContain("status-indicator-pr-ready");
    expect(prUp).not.toContain("status-indicator-pulse");
    const fixing = renderPicker({
      entries: [{ project, sessions, workers: [{ ...workers[0]!, status: "fixing_ci" }] }],
    });
    expect(fixing).toContain("status-indicator-fixing");
    expect(fixing).toContain("status-indicator-pulse");
  });

  it("keeps the idle tone on archived rows", () => {
    const archivedWorker: Worker = { ...workers[0]!, status: "archived" };
    const html = renderPicker({
      entries: [{ project, sessions, workers: [archivedWorker] }],
      defaultArchivedOpen: true,
    });
    expect(html).toContain("worker-badge-archived");
    expect(html).not.toContain("status-indicator-working");
  });
});

describe("SessionPicker (worker termination + archive, issue #64)", () => {
  it("shows the row ⋯ menu affordance on active worker rows only (issue #355, B5)", () => {
    const html = renderPicker({ onTerminateWorker: async () => {} });
    // ⋯ on the worker row, nothing on the project row.
    expect(html).toContain("picker-row-menu-toggle");
    expect(html).toContain('title="Session options"');
    // No standalone delete button on the row (issue #355, B5).
    expect(html).not.toContain("picker-terminate");
    const projectRow = html.slice(0, html.indexOf("picker-worker-row"));
    expect(projectRow).not.toContain("picker-row-menu-toggle");
  });

  it("shows no row-menu affordance when no terminate handler is wired", () => {
    const html = renderPicker();
    expect(html).not.toContain("picker-row-menu-toggle");
  });

  it("RowOptionsMenu: the ⋯ trigger opens the danger Delete entry; no inline confirm (issue #355, B5)", () => {
    const closed = renderToString(<RowOptionsMenu sessionId="s" open={false} entryLabel="Delete worker…" entryTitle="t" onToggle={() => {}} onAskTerminate={() => {}} />);
    expect(closed).toContain("picker-row-menu-toggle");
    expect(closed).toContain('aria-expanded="false"');
    // Closed by default — no menu until the toggle is clicked.
    expect(closed).not.toContain('class="picker-row-menu"');
    const open = renderToString(<RowOptionsMenu sessionId="s" open entryLabel="Delete worker…" entryTitle="t" onToggle={() => {}} onAskTerminate={() => {}} />);
    expect(open).toContain("picker-row-menu");
    expect(open).toContain("picker-menu-danger");
    expect(open).toContain("Delete worker…");
    // No inline confirm — the #268 modal owns it (#116/#355).
    expect(open).not.toContain("Delete worker?");
    expect(open).not.toContain("keep");
    expect(open).not.toContain("terminate-modal");
  });

  it("renders the terminate-confirmation modal (issue #116)", () => {
    const html = renderToString(
      <TerminateWorkerModal sessionName="proj-worker-1" pending={false} onConfirm={() => {}} onCancel={() => {}} />,
    );
    // Small centered modal over a dimmed backdrop, with the explicit way out.
    expect(html).toContain("terminate-modal-overlay");
    expect(html).toContain('role="dialog"');
    expect(html).toContain("terminate-modal");
    expect(html).toContain("Delete worker?");
    expect(html).toContain("proj-worker-1");
    expect(html).toContain("Delete");
    expect(html).toContain("Cancel");
  });

  it("shows the in-flight delete as pending", () => {
    const pending = renderToString(
      <TerminateWorkerModal sessionName="proj-worker-1" pending={true} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(pending).toContain("Deleting…");
    expect(pending).toContain("disabled");
  });

  it("moves archived workers into a collapsed per-project archive section", () => {
    const archivedWorker: Worker = { ...workers[0]!, status: "archived", statusMessage: "archived: terminated from the webapp" };
    const html = renderPicker({
      entries: [{ project, sessions, workers: [archivedWorker] }],
    });
    // Collapsed by default: the toggle with the count is there, the archived
    // session itself is not rendered.
    expect(html).toContain("picker-archived");
    expect(html).toMatch(/Archived \(<!-- -->1<!-- -->\)/);
    expect(html).toContain("picker-archived-toggle");
    expect(html).not.toContain("pideck-agentskiss-worker-1");
    // No active workers section anymore.
    expect(html).not.toContain("picker-workers");
  });

  it("renders archived workers dimmed with the archived badge and no terminate affordance when expanded", () => {
    const archivedWorker: Worker = { ...workers[0]!, status: "archived" };
    const html = renderPicker({
      entries: [{ project, sessions, workers: [archivedWorker] }],
      defaultArchivedOpen: true,
    });
    expect(html).toContain("picker-archived-list");
    expect(html).toContain("pideck-agentskiss-worker-1");
    expect(html).toContain("worker-badge-archived");
    expect(html).toContain("picker-archived-session");
    expect(html).toContain("View the archived worker");
    // History only: archived rows carry no row-menu affordance.
    expect(html).not.toContain('title="Session options"');
    const archivedRow = html.slice(html.indexOf("picker-archived-list"));
    expect(archivedRow).not.toContain("picker-session selected");
  });

  it("keeps live and archived workers apart in the same project", () => {
    const archivedWorker: Worker = { ...workers[0]!, id: "worker-2", status: "archived" };
    const secondWorkerSession: Session = { ...sessions[1]!, id: "sess-worker-2", tmuxSession: "pideck-agentskiss-worker-2", workerId: "worker-2" };
    const html = renderPicker({
      entries: [{ project, sessions: [...sessions, secondWorkerSession], workers: [...workers, archivedWorker] }],
      defaultArchivedOpen: true,
    });
    expect(html).toContain("picker-workers"); // live worker under the orchestrator
    expect(html).toMatch(/Archived \(<!-- -->1<!-- -->\)/);
    expect(html).toContain("pideck-agentskiss-worker-2");
  });
});
