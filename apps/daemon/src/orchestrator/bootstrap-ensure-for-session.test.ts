/**
 * Tests for `OrchestratorBootstrap.ensureForSession` (issue #290): the
 * relaunch/reconcile launch paths recreate orchestrator panes as bare
 * shells — putting pi back with its persona is the bootstrap's job. The
 * dispatch reuses the idempotent ensure paths, so a relaunched orchestrator
 * (project or global agent) runs the exact launch line of a fresh boot:
 * pi with the role's rendered persona file and the session id env. Kept in
 * its own file to stay under the source file's max-lines budget.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { Session } from "@pideck/shared";

import { testDaemon } from "../api/testutil.js";
import { ProjectLayout } from "../sessions/layout.js";
import { shQuote } from "../sessions/manager.js";

import { OrchestratorBootstrap } from "./bootstrap.js";

/** Prompt template fixture (same shape the #12 tests use). */
const TEMPLATE = [
  "## Orchestrator for {{PROJECT_ID}}",
  "Repo: {{PROJECT_REPO_URL}}",
  "",
].join("\n");

async function harness() {
  const daemon = testDaemon();
  const project = await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
  const promptPath = path.join(daemon.stateDir, "fixtures", "orchestrator.md");
  mkdirSync(path.dirname(promptPath), { recursive: true });
  writeFileSync(promptPath, TEMPLATE);
  const bootstrap = new OrchestratorBootstrap({
    sessions: daemon.services.sessions,
    tmux: daemon.services.tmux,
    layout: new ProjectLayout(daemon.stateDir),
    projects: daemon.services.projects,
    promptPath,
    // A freshly relaunched pane runs a shell, never the agent.
    isAgentRunning: async () => false,
  });
  return { daemon, bootstrap, project };
}

describe("OrchestratorBootstrap.ensureForSession (issue #290)", () => {
  it("relaunches the project orchestrator persona in a bare pane", async () => {
    const h = await harness();
    // Simulate the relaunch path's result: a fresh bare-shell pane (the
    // launch paths recreate orchestrator panes without the persona).
    const session = await h.daemon.services.sessions.ensureOrchestrator(h.project.id);

    const relaunched = await h.bootstrap.ensureForSession(session);

    // Same session, now running pi with the orchestrator persona — the
    // correct persona file (orchestrator-prompt.md) and its session id.
    expect(relaunched?.id).toBe(session.id);
    const line = h.daemon.tmux.sessions.get(session.tmuxSession)?.paneLines[0] ?? "";
    expect(line).toContain("pi --append-system-prompt");
    expect(line).toContain("orchestrator-prompt.md");
    expect(line).toContain(`PD_SESSION_ID=${shQuote(session.id)}`);
  });

  it("relaunches the global-agent persona (global-agent-prompt.md)", async () => {
    const h = await harness();
    const session = await h.daemon.services.sessions.ensureGlobalAgent();

    expect((await h.bootstrap.ensureForSession(session))?.id).toBe(session.id);
    const line = h.daemon.tmux.sessions.get(session.tmuxSession)?.paneLines[0] ?? "";
    expect(line).toContain("pi --append-system-prompt");
    expect(line).toContain("global-agent-prompt.md");
    expect(line).toContain(`PD_SESSION_ID=${shQuote(session.id)}`);
  });

  it("returns null for a worker session (its relaunch re-runs its recorded command)", async () => {
    const h = await harness();
    const worker: Session = {
      id: "sess-worker-1",
      projectId: h.project.id,
      role: "worker",
      tmuxSession: "pideck-x-worker-1",
      workerId: "worker-1",
      createdAt: "2026-09-06T12:00:00.000Z",
    };

    expect(await h.bootstrap.ensureForSession(worker)).toBeNull();
  });

  it("returns null for an orchestrator whose project is unknown", async () => {
    const h = await harness();
    const ghost: Session = {
      id: "sess-ghost",
      projectId: "deleted-project",
      role: "orchestrator",
      tmuxSession: "pideck-deleted-project-orchestrator-1",
      workerId: null,
      createdAt: "2026-09-06T12:00:00.000Z",
    };

    expect(await h.bootstrap.ensureForSession(ghost)).toBeNull();
  });
});
