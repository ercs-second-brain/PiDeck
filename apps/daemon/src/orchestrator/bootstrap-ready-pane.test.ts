/**
 * The orchestrator bootstrap's notification-delivery guard (issue #500):
 * `ensureReadyPane` guarantees a pane runs the agent persona and accepts
 * input before notification text is typed into it — a bare-shell pane (pi
 * never bootstrapped, e.g. a crash pre-bootstrap) is re-bootstrapped first,
 * and an unrecoverable pane is reported so callers skip loudly instead of
 * typing into the shell. Own file: bootstrap.test.ts sits at its size
 * budget; these tests carry a slim harness of their own.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { Project, Session } from "@pideck/shared";

import { testDaemon, type TestDaemon } from "../api/testutil.js";
import { ProjectLayout } from "../sessions/layout.js";
import { OrchestratorBootstrap } from "./bootstrap.js";

/** Minimal persona template: the recovery launch only needs the file to exist. */
const TEMPLATE = "## Orchestrator for {{PROJECT_ID}}\nRepo: {{PROJECT_REPO_URL}}\n";

interface Harness {
  daemon: TestDaemon;
  bootstrap: OrchestratorBootstrap;
  project: Project;
}

async function harness(options: { isAgentRunning?: (tmuxSession: string) => Promise<boolean>; recoveryInputReadyTimeoutMs?: number } = {}): Promise<Harness> {
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
    isAgentRunning: options.isAgentRunning ?? (async () => false),
    ...(options.recoveryInputReadyTimeoutMs !== undefined ? { recoveryInputReadyTimeoutMs: options.recoveryInputReadyTimeoutMs } : {}),
  });
  return { daemon, bootstrap, project };
}

describe("OrchestratorBootstrap.ensureReadyPane (issue #500)", () => {
  it("returns an already-bootstrapped pane untouched — nothing typed into it", async () => {
    const h = await harness({ isAgentRunning: async () => true });
    const session = await h.daemon.services.sessions.ensureOrchestrator(h.project.id);

    const ready = await h.bootstrap.ensureReadyPane(session);
    expect(ready).toBe(session);
    expect(h.daemon.tmux.invocations.filter((inv) => inv.args[0] === "send-keys")).toEqual([]);
  });

  it("re-bootstraps a bare-shell pane and declares it deliverable once pi's input box appears", async () => {
    const h = await harness({ isAgentRunning: async () => false, recoveryInputReadyTimeoutMs: 1_000 });
    const session = await h.daemon.services.sessions.ensureOrchestrator(h.project.id);
    // The freshly bootstrapped pi renders its input box: the border the
    // pane-ready probe looks for (pane-ready.ts) is in the trailing lines.
    h.daemon.tmux.notifyOutput(session.tmuxSession, "─".repeat(40));

    const ready = await h.bootstrap.ensureReadyPane(session);
    expect(ready).toBe(session);
    // The persona launch line was typed (the recovery).
    const lines = h.daemon.tmux.sessions.get(session.tmuxSession)?.paneLines ?? [];
    expect(lines.some((l) => l.includes("pi --no-skills --append-system-prompt"))).toBe(true);
  });

  it("reports a bare pane pi never mounts in as undeliverable — recovery attempted, caller must skip", async () => {
    const h = await harness({ isAgentRunning: async () => false, recoveryInputReadyTimeoutMs: 0 });
    const session = await h.daemon.services.sessions.ensureOrchestrator(h.project.id);

    const ready = await h.bootstrap.ensureReadyPane(session);
    expect(ready).toBeNull();
    // Recovery was attempted (the launch line is in the pane), but the pane
    // never became input-ready — the notification must not be typed.
    const lines = h.daemon.tmux.sessions.get(session.tmuxSession)?.paneLines ?? [];
    expect(lines.some((l) => l.includes("pi --no-skills --append-system-prompt"))).toBe(true);
  });

  it("reports an orchestrator pane of an unknown project as unrecoverable", async () => {
    const h = await harness();
    const orphan = { id: "orphan", role: "orchestrator", projectId: "no-such-project", tmuxSession: "orphan-pane", agentKind: undefined } as Session;

    expect(await h.bootstrap.ensureReadyPane(orphan)).toBeNull();
  });
});
