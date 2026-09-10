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
import { FakeGitRunner } from "./testing/fake-git.js";
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
    git: new FakeGitRunner().asRunner(),
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

  it("captures the archive scrollback with -J so logs reflow at the viewing width (issue #362)", async () => {
    const { manager, fake } = makeManager();
    const { session, worker } = await manager.spawnWorker("proj", { issueNumber: 13 });

    await manager.archiveWorker(worker.id);

    // Without -J the capture bakes the capture-time pane width into the
    // text, so a wide-captured log hard-wraps mid-word in a narrow viewer.
    const capture = fake.invocations.find(
      (inv) => inv.args[0] === "capture-pane" && inv.args.includes(session.tmuxSession),
    );
    expect(capture?.args).toContain("-J");
  });
});

describe("ArchivedLogStore fallback isolation (issue #372)", () => {
  it("a fresh instance over an absent file never sees another instance's saves", () => {
    // Regression: the shared EMPTY module constant was returned by reference
    // on absent files, so the first store's save() mutated the shared object
    // and a second store (fresh state dir, no file) saw its logs.
    const dirA = mkdtempSync(path.join(tmpdir(), "pideck-iso-a-"));
    const dirB = mkdtempSync(path.join(tmpdir(), "pideck-iso-b-"));
    const first = new ArchivedLogStore(path.join(dirA, "logs.json"));
    first.save("worker-1", { capturedAt: "2026-01-01T00:00:00.000Z", scrollback: "leaked?" });

    const second = new ArchivedLogStore(path.join(dirB, "logs.json"));
    expect(second.get("worker-1")).toBeUndefined();
  });
});
