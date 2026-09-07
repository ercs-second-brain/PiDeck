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
import { SessionPicker } from "./SessionPicker";

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
      selectedSessionId={overrides.selectedSessionId ?? null}
      selectedProjectId={overrides.selectedProjectId}
      startingProjectId={overrides.startingProjectId}
      onSelectSession={overrides.onSelectSession ?? (() => {})}
      onSelectProject={overrides.onSelectProject ?? (() => {})}
      onSelectAllProjects={overrides.onSelectAllProjects ?? (() => {})}
      onStartOnboarding={overrides.onStartOnboarding ?? (() => {})}
      onStartOrchestrator={overrides.onStartOrchestrator ?? (() => {})}
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

  it("renders project names as board-opening rows", () => {
    const html = renderPicker();
    expect(html).toContain("picker-project-name");
    expect(html).toContain("agentsKISS");
  });

  it("lists orchestrator and worker sessions with role badges", () => {
    const html = renderPicker();
    expect(html).toContain("role-orchestrator");
    expect(html).toContain("role-worker");
    expect(html).toContain("agentskiss-agentskiss-orchestrator-1");
    expect(html).toContain("agentskiss-agentskiss-worker-1");
  });

  it("shows the active worker status on worker sessions", () => {
    const html = renderPicker();
    expect(html).toContain("worker-badge active");
    expect(html).toContain("running");
  });

  it("nests workers beneath the project with the orchestrator first", () => {
    const html = renderPicker();
    const orchestrator = html.indexOf("agentskiss-agentskiss-orchestrator-1");
    const project = html.indexOf("agentsKISS");
    const worker = html.indexOf("agentskiss-agentskiss-worker-1");
    expect(project).toBeLessThan(orchestrator);
    expect(orchestrator).toBeLessThan(worker);
  });

  it("shows the start-orchestrator affordance when the project has no orchestrator", () => {
    const html = renderPicker();
    expect(html).not.toContain("Start orchestrator");
    const withoutOrchestrator = renderPicker({
      entries: [{ project, sessions: sessions.filter((s) => s.role === "worker"), workers }],
    });
    expect(withoutOrchestrator).toContain("picker-start-orchestrator");
    expect(withoutOrchestrator).toContain("Start orchestrator");
  });

  it("shows the start affordance for projects with no sessions at all", () => {
    const html = renderPicker({ entries: [{ project, sessions: [], workers: [] }] });
    expect(html).toContain("picker-start-orchestrator");
    expect(html).toContain("Start orchestrator");
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
    expect(html).toContain("picker-project-name selected");
  });

  it("shows the no-projects empty state pointing at the + button", () => {
    const html = renderPicker({ entries: [] });
    expect(html).toContain("No projects yet");
  });

  it("shows the daemon-unreachable error state", () => {
    const html = renderPicker({ entries: [], error: "connection refused" });
    expect(html).toContain("Daemon unreachable");
    expect(html).toContain("connection refused");
  });
});
