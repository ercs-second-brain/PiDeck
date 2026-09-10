/**
 * Read-only persona tool-gating across every launch path (issue #357 B7):
 * a kind spec's `readOnly` flag must gate the pane's tool set
 * (`--exclude-tools edit,write` via pi) at RUNTIME — enforcement in the
 * launch command, not just persona wording — on every path that (re)launches
 * the persona:
 *
 * - spawn (the api spawn route types the bootstrap launch line);
 * - relaunch (the #117 path re-runs the #290 bootstrap typing);
 * - reconcile-resurrect + startup sweep (#15/#27: the pane is recreated as
 *   a BARE shell — reconcile never re-runs a stale recorded command — and
 *   the sweep types the CURRENT spec's gating);
 * - and an archived persona agent (issue #357 B9) is never re-launched at
 *   all (defense in depth behind the relaunch/sweep guards).
 *
 * The gating always comes from the LIVE kind spec: flipping a user kind's
 * `readOnly` flag changes the next launch's tool set — no hardcoded kind
 * list anywhere (prompt-gate v2, issue #333).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionSchema } from "@pideck/shared";

import { startContractServer, type ContractServer } from "./contract-fixtures.js";

let server: ContractServer;
let daemon: ContractServer["daemon"];
let api: ContractServer["api"];

beforeAll(async () => {
  server = await startContractServer();
  daemon = server.daemon;
  api = server.api;
});

afterAll(async () => {
  await server?.close();
});

/** Registers a fresh project (its own clone dir) and returns its id. */
async function registerProject(id: string): Promise<string> {
  await daemon.services.projects.register({
    mode: "clone",
    repoUrl: `https://github.com/ak/${id}`,
  });
  return `ak-${id}`;
}

/** The first launch line typed into a session's pane (the #290 persona boot). */
function firstPaneLine(tmuxSession: string): string {
  const line = daemon.tmux.sessions.get(tmuxSession)?.paneLines[0] ?? "";
  expect(line).toContain("pi --no-skills --append-system-prompt");
  return line;
}

describe("read-only persona tool gating (issue #357 B7)", () => {
  it("gates a read-only shipped kind's pane at spawn (--exclude-tools edit,write)", async () => {
    const projectId = await registerProject("gate-spawn");
    const orchestrator = await daemon.services.sessions.ensureOrchestrator(projectId);

    const res = await api("POST", `/api/projects/${projectId}/spawn-agent`, {
      kind: "kiss-audit",
      name: "kiss-audit",
      parentSessionId: orchestrator.id,
    });
    expect(res.status).toBe(200);

    const line = firstPaneLine(sessionSchema.parse(res.json).tmuxSession);
    expect(line).toContain("--exclude-tools edit,write");
  });

  it("does not gate a read-write user kind (--exclude-tools absent)", async () => {
    const projectId = await registerProject("gate-rw");
    const orchestrator = await daemon.services.sessions.ensureOrchestrator(projectId);
    const saved = await api("POST", "/api/agent-kinds", {
      name: "docs-writer",
      label: "docs-writer",
      persona: "You write documentation.",
      spawnableBy: ["orchestrator", "worker", "reviewer", "global"],
      callerWaits: true,
      readOnly: false,
      trigger: "waitForInput",
      reportTarget: "caller",
      workerLike: false,
    });
    expect(saved.status).toBe(200);

    const res = await api("POST", `/api/projects/${projectId}/spawn-agent`, {
      kind: "docs-writer",
      name: "docs",
      parentSessionId: orchestrator.id,
      question: "write the README",
    });
    expect(res.status).toBe(200);

    const line = firstPaneLine(sessionSchema.parse(res.json).tmuxSession);
    expect(line).not.toContain("--exclude-tools");
  });

  it("re-applies the live spec's gating on relaunch — even after the spec flipped", async () => {
    const projectId = await registerProject("gate-relaunch");
    const orchestrator = await daemon.services.sessions.ensureOrchestrator(projectId);
    const spec = {
      name: "historian",
      label: "historian",
      persona: "You are the historian.",
      spawnableBy: ["orchestrator", "worker", "reviewer", "global"],
      callerWaits: true,
      readOnly: true,
      trigger: "waitForInput" as const,
      reportTarget: "caller" as const,
      workerLike: false,
    };
    expect((await api("POST", "/api/agent-kinds", spec)).status).toBe(200);

    const spawned = await api("POST", `/api/projects/${projectId}/spawn-agent`, {
      kind: "historian",
      name: "hist",
      parentSessionId: orchestrator.id,
      question: "go",
    });
    const session = sessionSchema.parse(spawned.json);
    // Launched read-only: the pane is gated.
    expect(firstPaneLine(session.tmuxSession)).toContain("--exclude-tools edit,write");

    // The pane dies; the user flips the kind to read-write; relaunch.
    daemon.tmux.sessions.delete(session.tmuxSession);
    expect(
      (await api("PUT", "/api/agent-kinds/historian", { ...spec, readOnly: false })).status,
    ).toBe(200);
    const relaunch = await api("POST", `/api/sessions/${session.id}/relaunch`);
    expect(relaunch.status).toBe(200);

    // The relaunch reads the LIVE spec: the new pane is NOT gated.
    const line = firstPaneLine(session.tmuxSession);
    expect(line).not.toContain("--exclude-tools");
  });

  it("resurrects agent-kind panes as bare shells — reconcile never runs a stale command", async () => {
    const projectId = await registerProject("gate-reconcile");
    const orchestrator = await daemon.services.sessions.ensureOrchestrator(projectId);
    const spawned = await api("POST", `/api/projects/${projectId}/spawn-agent`, {
      kind: "devex-audit",
      name: "audit",
      parentSessionId: orchestrator.id,
    });
    const session = sessionSchema.parse(spawned.json);

    // Reboot: the tmux server is gone; only the registry record remains.
    daemon.tmux.sessions.clear();
    const result = await daemon.services.sessions.reconcile();
    expect(result.resurrected.map((s) => s.tmuxSession)).toContain(session.tmuxSession);
    // Bare shell: no pi launch line typed by reconcile, no stale command run —
    // the tool gating is decided by the bootstrap, from the live spec.
    const resurrected = daemon.tmux.sessions.get(session.tmuxSession);
    expect(resurrected?.command ?? []).toEqual([]);
    expect(resurrected?.paneLines ?? []).toEqual([]);

    // The startup sweep then types the launch line — with the gating.
    await daemon.services.orchestratorBootstrap.ensureAll();
    expect(firstPaneLine(session.tmuxSession)).toContain("--exclude-tools edit,write");
  });
});

describe("archived persona agents are never re-launched (issue #357 B9)", () => {
    it("never re-launches an archived persona agent's persona (issue #357 B9)", async () => {
    const projectId = await registerProject("gate-archived");
    const orchestrator = await daemon.services.sessions.ensureOrchestrator(projectId);
    const spawned = await api("POST", `/api/projects/${projectId}/spawn-agent`, {
      kind: "kiss-audit",
      name: "audit",
      parentSessionId: orchestrator.id,
    });
    const session = sessionSchema.parse(spawned.json);
    expect((await api("POST", `/api/sessions/${session.id}/terminate`)).status).toBe(200);

    // The startup sweep skips archived persona agents: no new launch line.
    daemon.tmux.sessions.clear();
    await daemon.services.orchestratorBootstrap.ensureAll();
    expect(daemon.tmux.sessions.get(session.tmuxSession)).toBeUndefined();
  });
});
