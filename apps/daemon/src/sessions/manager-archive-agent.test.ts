/**
 * Persona-agent archive tests (issue #357 B9/B10):
 * `SessionManager.archiveAgentSession` — the session-record twin of the
 * #64 worker archive — and reconcile's skip of archived persona agents.
 * Mechanics live in `manager-archive.ts`; the facade delegates.
 */

import { describe, expect, it } from "vitest";
import { SessionManager } from "./manager.js";
import { SessionRegistry } from "./registry.js";
import { FakeGitRunner } from "./testing/fake-git.js";
import { FakeTmuxRunner } from "./testing/fake-tmux.js";
import { Tmux } from "./tmux.js";
import { makeSessionManager } from "./testing/fake-manager.js";

const makeManager = () => makeSessionManager({ tmpPrefix: "pideck-archive-agent-" });

const fakePaneState = (command: string[], cwd: string | undefined) => ({
  command,
  cwd,
  paneLines: [] as string[],
  cols: 80,
  rows: 24,
});

describe("SessionManager.archiveAgentSession (issue #357 B9)", () => {
  it("archives a persona agent: scrollback captured, pane killed, record kept with archivedAt", async () => {
    const { manager, fake, layout } = makeManager();
    const agent = await manager.spawnAgentKind("proj", { kind: "devex-audit", parentSessionId: "sess-parent-1", name: "audit" });
    fake.notifyOutput(agent.tmuxSession, "audit finding: CI wastes 20 minutes per run");

    const archived = await manager.archiveAgentSession(agent.id);

    // The pane is dead and its final bytes were captured (the #104 pattern).
    expect(fake.sessions.has(agent.tmuxSession)).toBe(false);
    expect(manager.archivedAgentScrollback(agent.id)?.scrollback).toContain("CI wastes 20 minutes per run");
    expect(manager.archivedAgentScrollback(agent.id)?.capturedAt).toBeDefined();
    // The record is kept — marked, never deleted.
    expect(archived?.archivedAt).toBeDefined();
    expect(new SessionRegistry(layout.sessionsFilePath()).getSession(agent.id)).toBeDefined();
    // Live listings exclude it.
    expect(manager.listSessions("proj").some((session) => session.id === agent.id)).toBe(false);
  });

  it("cascades the archive to every live descendant persona agent (issue #357 B10)", async () => {
    const { manager, fake, layout } = makeManager();
    const parent = await manager.spawnAgentKind("proj", { kind: "devex-audit", parentSessionId: "sess-parent-1", name: "audit" });
    const child = await manager.spawnAgentKind("proj", { kind: "researcher", parentSessionId: parent.id, name: "research" });
    const grandchild = await manager.spawnAgentKind("proj", { kind: "researcher", parentSessionId: child.id, name: "nested" });
    const unrelated = await manager.spawnAgentKind("proj", { kind: "kiss-audit", parentSessionId: "sess-parent-1", name: "other" });

    await manager.archiveAgentSession(parent.id);

    const stored = new SessionRegistry(layout.sessionsFilePath());
    for (const session of [parent, child, grandchild]) {
      expect(stored.getSession(session.id)?.archivedAt).toBeDefined();
      expect(fake.sessions.has(session.tmuxSession)).toBe(false);
    }
    // Outside the lineage: untouched.
    expect(stored.getSession(unrelated.id)?.archivedAt).toBeUndefined();
    expect(fake.sessions.has(unrelated.tmuxSession)).toBe(true);
  });

  it("is idempotent: re-archiving an archived persona agent keeps the first capture", async () => {
    const { manager, fake } = makeManager();
    const agent = await manager.spawnAgentKind("proj", { kind: "kiss-audit", parentSessionId: "sess-parent-1", name: "audit" });
    fake.notifyOutput(agent.tmuxSession, "finding one");
    await manager.archiveAgentSession(agent.id);
    const first = manager.archivedAgentScrollback(agent.id);

    const again = await manager.archiveAgentSession(agent.id);
    expect(again?.archivedAt).toBeDefined();
    expect(manager.archivedAgentScrollback(agent.id)).toEqual(first);
  });

  it("falls back to killSession semantics for non-agent-kind sessions", async () => {
    const { manager, fake, layout } = makeManager();
    const orchestrator = await manager.ensureOrchestrator("proj");

    const removed = await manager.archiveAgentSession(orchestrator.id);

    expect(removed?.id).toBe(orchestrator.id);
    expect(removed?.archivedAt).toBeUndefined(); // deleted, not archived
    expect(new SessionRegistry(layout.sessionsFilePath()).getSession(orchestrator.id)).toBeUndefined();
    expect(fake.sessions.has(orchestrator.tmuxSession)).toBe(false);
  });

  it("returns null for an unknown session id", async () => {
    const { manager } = makeManager();
    expect(await manager.archiveAgentSession("sess-698a0314")).toBeNull();
  });

  it("captures the archive scrollback with -J so logs reflow at the viewing width (issue #392)", async () => {
    const { manager, fake } = makeManager();
    const agent = await manager.spawnAgentKind("proj", { kind: "devex-audit", parentSessionId: "sess-parent-1", name: "audit" });

    await manager.archiveAgentSession(agent.id);

    // Regression (issue #392, the #362 twin for persona agents): without -J
    // the capture bakes the capture-time pane width into the stored
    // scrollback, so long-line agent reports hard-wrap mid-word in a narrow
    // viewer. The shared capture helper (also used by the worker archive)
    // must pass -J here too.
    const capture = fake.invocations.find(
      (inv) => inv.args[0] === "capture-pane" && inv.args.includes(agent.tmuxSession),
    );
    expect(capture?.args).toContain("-J");
  });
});

describe("reconcile skips archived persona agents (issue #357 B9)", () => {
  it("never resurrects an archived persona agent after a daemon restart or reboot", async () => {
    const { manager, layout } = makeManager();
    const orchestrator = await manager.ensureOrchestrator("proj");
    const agent = await manager.spawnAgentKind("proj", { kind: "devex-audit", parentSessionId: orchestrator.id, name: "audit" });
    await manager.archiveAgentSession(agent.id);

    // Reboot: the tmux server is gone; only the persisted registry remains.
    const rebooted = new FakeTmuxRunner();
    const manager2 = new SessionManager({
      tmux: new Tmux({ runner: rebooted.asRunner() }),
      registry: new SessionRegistry(layout.sessionsFilePath()),
      layout,
      git: new FakeGitRunner().asRunner(),
    });
    const result = await manager2.reconcile();

    // The orchestrator resurrects; the archived persona agent is skipped
    // entirely (no resurrect, no lost, no pane recreation).
    expect(result.resurrected.map((s) => s.tmuxSession)).toEqual([orchestrator.tmuxSession]);
    expect(result.lost.map((s) => s.id)).not.toContain(agent.id);
    expect(rebooted.sessions.has(agent.tmuxSession)).toBe(false);
    expect(manager2.listSessions().some((s) => s.id === agent.id)).toBe(false);
  });

  it("skips an archived persona agent even when its tmux pane is still alive", async () => {
    const { manager, fake, layout } = makeManager();
    const agent = await manager.spawnAgentKind("proj", { kind: "kiss-audit", parentSessionId: "sess-parent-1", name: "audit" });
    await manager.archiveAgentSession(agent.id);
    // Edge: the pane outlived the archive (tmux kill raced a reboot).
    fake.sessions.set(agent.tmuxSession, fakePaneState(["pi"], undefined));

    const registry2 = new SessionRegistry(layout.sessionsFilePath());
    const manager2 = new SessionManager({
      tmux: new Tmux({ runner: fake.asRunner() }),
      registry: registry2,
      layout,
      git: new FakeGitRunner().asRunner(),
    });
    const result = await manager2.reconcile();

    expect(result.alive.map((s) => s.tmuxSession)).not.toContain(agent.tmuxSession);
    expect(result.resurrected).toEqual([]);
    expect(result.lost).toEqual([]);
  });
});
