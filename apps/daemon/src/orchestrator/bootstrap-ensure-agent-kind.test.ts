/**
 * Tests for `OrchestratorBootstrap.ensureAgentKindSession` (issue #310):
 * agent-kind sessions (docs/agent-kinds.md) follow the #290 pattern — the
 * spawn/relaunch/reconcile launch paths leave a bare-shell pane, and the
 * bootstrap renders the kind persona (parent lineage + report target) and
 * types the pi launch line, idempotently via the pane probe.
 */

import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { testDaemon } from "../api/testutil.js";
import { agentKindPromptFilePath } from "../sessions/agent-kinds.js";
import { ProjectLayout } from "../sessions/layout.js";
import { shQuote } from "../sessions/manager.js";

import { OrchestratorBootstrap } from "./bootstrap.js";

async function harness(isAgentRunning: (tmuxSession: string) => Promise<boolean> = async () => false) {
  const daemon = testDaemon();
  const project = await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
  // The kind personas live in the repo's agent/prompts dir (auto-discovered);
  // the renderer only needs the project values, so no template fixture here.
  mkdirSync(path.join(daemon.stateDir, "projects", project.id), { recursive: true });
  const bootstrap = new OrchestratorBootstrap({
    sessions: daemon.services.sessions,
    tmux: daemon.services.tmux,
    layout: new ProjectLayout(daemon.stateDir),
    projects: daemon.services.projects,
    isAgentRunning,
  });
  return { daemon, bootstrap, project };
}

describe("OrchestratorBootstrap.ensureAgentKindSession (issue #310)", () => {
  it("types the kind persona launch line into a bare audit pane, with the report target rendered", async () => {
    const h = await harness();
    const audit = await h.daemon.services.sessions.spawnAgentKind(h.project.id, {
      kind: "kiss-audit",
      parentSessionId: "sess-parent-1",
      name: "audit",
    });

    const ensured = await h.bootstrap.ensureForSession(audit);

    expect(ensured?.id).toBe(audit.id);
    const line = h.daemon.tmux.sessions.get(audit.tmuxSession)?.paneLines[0] ?? "";
    // The full launch line: pi with the kind persona, session id env, and
    // the read-only tool exclusion — typed, exactly like an orchestrator's.
    expect(line).toContain("pi --append-system-prompt");
    expect(line).toContain(`agent-prompt-${audit.id}.md`);
    expect(line).toContain(`PD_SESSION_ID=${shQuote(audit.id)}`);
    expect(line).toContain("--exclude-tools edit,write");

    // The persona file is rendered: the audit reports to the project
    // orchestrator (ensured live), PROJECT_PATH is the recorded workspace.
    const persona = readFileSync(agentKindPromptFilePath(new ProjectLayout(h.daemon.stateDir), h.project.id, audit.id), "utf8");
    const orchestrator = h.daemon.services.sessions.listSessions(h.project.id).find((s) => s.role === "orchestrator");
    expect(orchestrator).toBeDefined();
    expect(persona).toContain(`pideck send --session ${orchestrator!.id}`);
    expect(persona).toContain(audit.cwd!);
    expect(persona).not.toContain("{{ORCHESTRATOR_SESSION_ID}}");
  });

  it("renders the investigator's parent lineage ({{PARENT_SESSION_ID}})", async () => {
    const h = await harness();
    const investigator = await h.daemon.services.sessions.spawnAgentKind(h.project.id, {
      kind: "investigator",
      parentSessionId: "sess-caller-9",
    });

    await h.bootstrap.ensureForSession(investigator);

    const persona = readFileSync(
      agentKindPromptFilePath(new ProjectLayout(h.daemon.stateDir), h.project.id, investigator.id),
      "utf8",
    );
    expect(persona).toContain("pideck send --session sess-caller-9");
    expect(persona).not.toContain("{{PARENT_SESSION_ID}}");
    expect(persona).not.toContain("{{ORCHESTRATOR_SESSION_ID}}");
  });

  it("is idempotent: the launch line is not typed twice into a running pane", async () => {
    const h = await harness(async () => true); // probe: agent already running
    const audit = await h.daemon.services.sessions.spawnAgentKind(h.project.id, {
      kind: "devex-audit",
      parentSessionId: "p",
    });

    await h.bootstrap.ensureForSession(audit);
    await h.bootstrap.ensureForSession(audit);

    expect(h.daemon.tmux.sessions.get(audit.tmuxSession)?.paneLines).toEqual([]);
  });

  it("returns null for sessions whose project is unknown", async () => {
    const h = await harness();
    const ghost: Parameters<typeof h.bootstrap.ensureForSession>[0] = {
      id: "sess-ghost-kind",
      projectId: "deleted-project",
      role: "worker",
      tmuxSession: "pideck-deleted-project-worker-1",
      agentKind: "kiss-audit",
      workerId: null,
      createdAt: "2026-09-09T12:00:00.000Z",
    };
    expect(await h.bootstrap.ensureForSession(ghost)).toBeNull();
  });

  it("heals every registered kind session in the startup sweep (ensureAll)", async () => {
    const h = await harness();
    await h.daemon.services.sessions.spawnAgentKind(h.project.id, { kind: "kiss-audit", parentSessionId: "p", name: "a1" });
    await h.daemon.services.sessions.spawnAgentKind(h.project.id, { kind: "investigator", parentSessionId: "p", name: "i1" });

    await h.bootstrap.ensureAll();

    // Both kind panes got their persona launch line (bare shells before).
    for (const session of h.daemon.services.sessions.listSessions(h.project.id)) {
      if (session.agentKind === undefined) continue;
      const line = h.daemon.tmux.sessions.get(session.tmuxSession)?.paneLines[0] ?? "";
      expect(line).toContain(`agent-prompt-${session.id}.md`);
    }
  });
});
