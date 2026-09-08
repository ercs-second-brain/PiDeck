/**
 * Terminate-time scrollback capture (issue #104): archiving a worker
 * captures its pane bytes while the tmux session is still alive, persists
 * them (JsonStore), and only then kills the pane — the webapp's archived
 * log view is built on this.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "./manager.js";
import { ArchivedLogStore } from "./archived-logs.js";
import { ProjectLayout } from "./layout.js";
import { SessionRegistry } from "./registry.js";
import { FakeTmuxRunner } from "./testing/fake-tmux.js";
import { Tmux } from "./tmux.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "pideck-archive-log-"));
});

function makeManager(): { manager: SessionManager; fake: FakeTmuxRunner; layout: ProjectLayout } {
  const fake = new FakeTmuxRunner();
  const layout = new ProjectLayout(stateDir);
  const manager = new SessionManager({
    tmux: new Tmux({ runner: (args) => fake.run(args) }),
    registry: new SessionRegistry(layout.sessionsFilePath()),
    layout,
  });
  return { manager, fake, layout };
}

describe("terminate captures scrollback (issue #104)", () => {
  it("captures the pane bytes first, persists them, then kills tmux", async () => {
    const { manager, fake, layout } = makeManager();
    const { session, worker } = await manager.spawnWorker("proj", { issueNumber: 11 });
    fake.notifyOutput(session.tmuxSession, "building…\ndone\n");

    const archived = await manager.archiveWorker(worker.id);
    expect(archived?.status).toBe("archived");

    // Capture happened while the pane was still alive, and before the kill.
    const order = fake.invocations.map((invocation) => invocation.args.join(" "));
    const captureAt = order.findIndex((entry) => entry.includes("capture-pane") && entry.includes(session.tmuxSession));
    const killAt = order.findIndex((entry) => entry.includes("kill-session"));
    expect(captureAt).toBeGreaterThan(-1);
    expect(killAt).toBeGreaterThan(captureAt);

    const captured = manager.archivedScrollback(worker.id);
    expect(captured?.scrollback).toContain("done");
    expect(captured?.capturedAt).toBeDefined();
    expect(fake.sessions.has(session.tmuxSession)).toBe(false); // pane gone after capture

    // Persisted via JsonStore, so a later store instance still serves it.
    const reloaded = new ArchivedLogStore(layout.archivedLogsFilePath());
    expect(reloaded.get(worker.id)?.scrollback).toContain("done");
  });

  it("archives without a capture when the tmux session is already dead", async () => {
    const { manager, fake } = makeManager();
    const { worker } = await manager.spawnWorker("proj", { issueNumber: 12 });
    fake.sessions.clear(); // pane died (e.g. pi exited) before the terminate

    await manager.archiveWorker(worker.id);
    expect(manager.archivedScrollback(worker.id)).toBeUndefined();
    expect(manager.getWorker(worker.id)?.status).toBe("archived");
  });
});
