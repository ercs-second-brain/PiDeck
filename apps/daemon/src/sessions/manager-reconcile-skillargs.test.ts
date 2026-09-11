/**
 * Reconcile regression for issue #460: pre-upgrade persisted worker
 * commands carry `--skill` args for the seven shipped global integration
 * skills #439 removed; reconcile must resurrect those panes cleanly — the
 * resurrection guard drops dangling skill paths instead of re-erroring
 * them into every reloaded pane. Split from manager-reconcile.test.ts to
 * respect its max-lines budget (kiss ratchet).
 */

import { describe, expect, it } from "vitest";
import { serializeCommand, SessionManager } from "./manager.js";
import { FakeGitRunner } from "./testing/fake-git.js";
import { FakeTmuxRunner } from "./testing/fake-tmux.js";
import { makeSessionManager } from "./testing/fake-manager.js";
import { SessionRegistry } from "./registry.js";
import { Tmux } from "./tmux.js";

const makeManager = () => makeSessionManager({ tmpPrefix: "pideck-reconcile-skillargs-" });

// ---------------------------------------------------------------------------
// Issue #460: pre-upgrade recorded commands carrying the seven shipped
// global skills #439 removed must reconcile cleanly — the resurrection
// guard drops the dangling --skill paths instead of re-erroring them into
// every reloaded pane.
// ---------------------------------------------------------------------------

const REMOVED_SKILLS = [
  "using-pideck",
  "create-issue",
  "spawn-worker",
  "report-pr",
  "ci-status",
  "review-comments",
  "review-pr",
];

describe("reconcile drops dangling --skill paths from recorded commands (issue #460)", () => {
  it("resurrects a pre-#439 worker pane with zero dangling skill args", async () => {
    const { manager, layout, registry } = makeManager();
    const { session } = await manager.spawnWorker("proj", { issueNumber: 46 });

    // Simulate the pre-#439 persisted record: the recorded spawn command
    // names all seven shipped global skills (removed by #439).
    const stale = [
      "pi",
      "--no-skills",
      ...REMOVED_SKILLS.flatMap((name) => ["--skill", `/nonexistent/pideck/src/agent/skills/${name}`]),
    ];
    registry.setSessionCommand(session.id, serializeCommand(stale));

    // Reboot: the tmux server is gone; reconcile resurrects from the
    // recorded command.
    const rebooted = new FakeTmuxRunner();
    const registry2 = new SessionRegistry(layout.sessionsFilePath());
    const manager2 = new SessionManager({
      tmux: new Tmux({ runner: (args) => rebooted.run(args) }),
      registry: registry2,
      layout,
      git: new FakeGitRunner().asRunner(),
    });
    await manager2.reconcile();

    const pane = rebooted.sessions.get(session.tmuxSession);
    expect(pane?.command).toBeDefined();
    const inner = pane?.command[2] ?? "";
    for (const name of REMOVED_SKILLS) {
      expect(inner).not.toContain(name);
    }
    expect(inner).not.toContain("--skill");
    // The guard shape is unchanged: pi on PATH, else interactive shell.
    expect(inner).toContain("command -v pi");
  });
});
