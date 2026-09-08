/**
 * Tests for the terminal sidebar (SessionPicker, issue #62): the "Projects"
 * header with the "+" onboarding button, per-project IA (project rows open
 * boards; orchestrator nested above workers, start-orchestrator affordance
 * when absent), role/worker badges, selection state, and empty/error
 * handling. The sidebar is pure, so it is exercised directly without xterm
 * or effects.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { Project, Session, Worker } from "@agentskiss/shared";
import { SessionPicker, TerminateWorkerButton } from "./SessionPicker";

const project: Project = {
  id: "agentskiss",
  name: "agentsKISS",
  repoUrl: "https://github.com/ercs-second-brain/agentsKISS",
  defaultBranch: "main",
  settings: { autoAgentUsername: null, workerConcurrency: 2 },
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const sessions: Session[] = [
  {
    id: "sess-orch-1",
    projectId: "agentskiss",
    role: "orchestrator",
    tmuxSession: "agentskiss-agentskiss-orchestrator-1",
    workerId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
  },
  {
    id: "sess-worker-1",
    projectId: "agentskiss",
    role: "worker",
    tmuxSession: "agentskiss-agentskiss-worker-1",
    workerId: "worker-1",
    createdAt: "2025-01-01T00:00:00.000Z",
  },
];

const workers: Worker[] = [
  {
    id: "worker-1",
    projectId: "agentskiss",
    sessionId: "sess-worker-1",
    issueNumber: 7,
    prNumber: null,
    status: "running",
    statusMessage: null,
    startedAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
];

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
      onSelectSession={overrides.onSelectSession ?? (() => {})}
      onSelectProject={overrides.onSelectProject ?? (() => {})}
      onSelectAllProjects={overrides.onSelectAllProjects ?? (() => {})}
      onStartOnboarding={overrides.onStartOnboarding ?? (() => {})}
      onStartOrchestrator={overrides.onStartOrchestrator ?? (() => {})}
      onTerminateWorker={overrides.onTerminateWorker}
    />,
  );
}

describe("SessionPicker", () => {
  it("renders the Projects header with the + onboarding button", () => {
    const html = renderPicker();
    expect(html).toContain("picker-title-button");
    expect(html).toContain(">Projects</button>");
    expect(html).toContain("picker-add");
  });

  it("renders the project name as the orchestrator entry with a kanban icon (issue #108)", () => {
    const html = renderPicker();
    expect(html).toContain("picker-project-row");
    expect(html).toContain("picker-project-name");
    expect(html).toContain("agentsKISS");
    expect(html).toContain("picker-project-board");
    expect(html).toContain("Attach agentsKISS&#x27;s orchestrator terminal");
  });

  it("lists worker sessions with role badges; the orchestrator row is gone (issue #108)", () => {
    const html = renderPicker();
    expect(html).toContain("role-worker");
    expect(html).toContain("agentskiss-agentskiss-worker-1");
    // Issue #108: no separate orchestrator row — the project name is the entry.
    expect(html).not.toContain("agentskiss-agentskiss-orchestrator-1");
    expect(html).not.toContain("role-orchestrator");
  });

  it("nests workers beneath the project row (issue #63)", () => {
    const html = renderPicker();
    const project = html.indexOf("agentsKISS");
    const worker = html.indexOf("agentskiss-agentskiss-worker-1");
    expect(project).toBeLessThan(worker);
    // The worker list is a tree-indented list under the project row.
    expect(html).toContain("picker-workers");
    expect(html).toContain("picker-worker-row");
  });

  it("keeps worker status badges and selection on indented worker rows (issue #63)", () => {
    const html = renderPicker({ selectedSessionId: "sess-worker-1" });
    // Worker rows keep the live status badge and the selected class.
    expect(html).toContain("status-indicator-working");
    expect(html).toContain("picker-session selected");
    expect(html).toContain("role-worker");
  });

  it("uses the project-name click to start the orchestrator when absent (issue #108)", () => {
    const withoutOrchestrator = renderPicker({
      entries: [{ project, sessions: sessions.filter((s) => s.role === "worker"), workers }],
    });
    expect(withoutOrchestrator).not.toContain("picker-start-orchestrator");
    expect(withoutOrchestrator).toContain("Start agentsKISS&#x27;s orchestrator");
  });

  it("offers the orchestrator start through the project name for projects with no sessions", () => {
    const html = renderPicker({ entries: [{ project, sessions: [], workers: [] }] });
    expect(html).toContain("Start agentsKISS&#x27;s orchestrator");
    expect(html).not.toContain("No active sessions.");
  });

  it("marks the starting orchestrator as pending", () => {
    const html = renderPicker({
      entries: [{ project, sessions: [], workers: [] }],
      startingProjectId: project.id,
    });
    expect(html).toContain("Starting…");
    expect(html).toContain("disabled");
  });

  it("marks the selected session", () => {
    const html = renderPicker({ selectedSessionId: "sess-worker-1" });
    const selected = html.match(/picker-session selected/g) ?? [];
    expect(selected).toHaveLength(1);
  });

  it("marks the project whose board is open in the main pane", () => {
    const html = renderPicker({ selectedProjectId: project.id });
    expect(html).toContain("picker-project-board selected");
  });

  it("marks the project name as selected while its orchestrator is attached (issue #108)", () => {
    const html = renderPicker({ selectedSessionId: "sess-orch-1" });
    expect(html).toContain("picker-project-name selected");
  });

  it("shows the no-projects empty state pointing at the + button", () => {
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
  it("shows the terminate affordance on active worker rows only", () => {
    const html = renderPicker({ onTerminateWorker: () => {} });
    // ✕ on the worker row, nothing on the project row.
    expect(html).toContain("picker-terminate");
    expect(html).toContain('title="Terminate worker"');
    const projectRow = html.slice(0, html.indexOf("picker-worker-row"));
    expect(projectRow).not.toContain("picker-terminate");
  });

  it("shows no terminate affordance when no handler is wired", () => {
    const html = renderPicker();
    expect(html).not.toContain("picker-terminate");
  });

  it("TerminateWorkerButton asks for confirmation before terminating", () => {
    const idle = renderToString(
      <TerminateWorkerButton confirming={false} pending={false} onAsk={() => {}} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(idle).toContain("picker-terminate");
    expect(idle).toContain("✕");
    expect(idle).not.toContain("Terminate?");

    const confirming = renderToString(
      <TerminateWorkerButton confirming={true} pending={false} onAsk={() => {}} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(confirming).toContain("Terminate?");
    expect(confirming).toContain("picker-terminate-confirm-yes");
    // The explicit keep-alive way out.
    expect(confirming).toContain("keep");
    expect(confirming).toContain("picker-terminate-confirm-no");
  });

  it("shows the in-flight terminate as pending", () => {
    const pending = renderToString(
      <TerminateWorkerButton confirming={true} pending={true} onAsk={() => {}} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(pending).toContain("Terminating…");
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
    expect(html).not.toContain("agentskiss-agentskiss-worker-1");
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
    expect(html).toContain("agentskiss-agentskiss-worker-1");
    expect(html).toContain("worker-badge-archived");
    expect(html).toContain("picker-archived-session");
    expect(html).toContain("View the archived worker");
    // History only: archived rows carry no terminate affordance.
    expect(html).not.toContain('title="Terminate worker"');
    const archivedRow = html.slice(html.indexOf("picker-archived-list"));
    expect(archivedRow).not.toContain("picker-session selected");
  });

  it("keeps live and archived workers apart in the same project", () => {
    const archivedWorker: Worker = { ...workers[0]!, id: "worker-2", status: "archived" };
    const secondWorkerSession: Session = { ...sessions[1]!, id: "sess-worker-2", tmuxSession: "agentskiss-agentskiss-worker-2", workerId: "worker-2" };
    const html = renderPicker({
      entries: [{ project, sessions: [...sessions, secondWorkerSession], workers: [...workers, archivedWorker] }],
      defaultArchivedOpen: true,
    });
    expect(html).toContain("picker-workers"); // live worker under the orchestrator
    expect(html).toMatch(/Archived \(<!-- -->1<!-- -->\)/);
    expect(html).toContain("agentskiss-agentskiss-worker-2");
  });
});
