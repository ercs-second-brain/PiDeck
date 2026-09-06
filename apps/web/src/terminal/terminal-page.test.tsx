/**
 * Tests for the terminal session picker: role/worker badges, selection
 * state, and empty/error handling. The page shell is pure once the fetched
 * data arrives, so the picker is exercised directly.
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

function renderPicker(overrides: Partial<Parameters<typeof SessionPicker>[0]> = {}) {
  return renderToString(
    <SessionPicker
      entries={overrides.entries ?? [{ project, sessions, workers }]}
      error={overrides.error ?? null}
      selectedId={overrides.selectedId ?? null}
      onSelect={overrides.onSelect ?? (() => {})}
    />,
  );
}

describe("SessionPicker", () => {
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

  it("marks the selected session", () => {
    const html = renderPicker({ selectedId: "sess-worker-1" });
    const selected = html.match(/picker-session selected/g) ?? [];
    expect(selected).toHaveLength(1);
  });

  it("shows a per-project empty state", () => {
    const html = renderPicker({ entries: [{ project, sessions: [], workers: [] }] });
    expect(html).toContain("No active sessions.");
  });

  it("shows the daemon-unreachable error state", () => {
    const html = renderPicker({ entries: [], error: "connection refused" });
    expect(html).toContain("Daemon unreachable");
    expect(html).toContain("connection refused");
  });
});
