/**
 * Worker-pane persona asset tests (issue #315): the default worker command
 * gains the worker persona's deployed prompt override (`--append-system-
 * prompt`) and applied skills (`--skill`) — recorded on the session so
 * relaunch/reconcile re-run the identical command. An explicit `command`
 * option still wins, and with no assets the command stays plain `pi`.
 *
 * The test daemon's context already wires one shared `AgentAssetsStore` into
 * both the session manager and the bootstrap (api/context.ts), so the store
 * under test is `daemon.services.agentAssets` itself.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";

import { testDaemon, type TestDaemon } from "../api/testutil.js";

describe("worker pane persona assets (issue #315)", () => {
  it("records the worker override and applied skills in the spawned command", async () => {
    const daemon: TestDaemon = testDaemon();
    const assets = daemon.services.agentAssets;
    assets.savePromptOverride("worker", "Custom worker conventions");
    assets.saveSkill("worker-helper", { content: "helper skill", personas: ["worker"] });
    assets.saveSkill("orchestrator-only", { content: "not for workers", personas: ["orchestrator"] });

    const { session, worker } = await daemon.services.sessions.spawnWorker("p1", { issueNumber: 7 });

    expect(worker.status).toBe("running");
    const command = session.command ?? "";
    expect(command).toContain("pi");
    expect(command).toContain(
      `--append-system-prompt ${path.join(daemon.stateDir, "agent-assets", "prompts", "worker.md")}`,
    );
    expect(command).toContain(`--skill ${path.join(daemon.stateDir, "agent-assets", "skills", "worker-helper.md")}`);
    expect(command).not.toContain("orchestrator-only");
  });

  it("keeps a plain pi command when no worker assets are applied", async () => {
    const daemon: TestDaemon = testDaemon();
    const { session } = await daemon.services.sessions.spawnWorker("p1", { issueNumber: 8 });
    expect(session.command).toBe("pi");
  });

  it("lets an explicit command option skip the persona shaping", async () => {
    const daemon: TestDaemon = testDaemon();
    daemon.services.agentAssets.saveSkill("worker-helper", { content: "helper skill", personas: ["worker"] });
    const { session } = await daemon.services.sessions.spawnWorker("p1", {
      issueNumber: 9,
      command: ["pi", "--no-skills"],
    });
    expect(session.command).toBe("pi --no-skills");
  });
});
