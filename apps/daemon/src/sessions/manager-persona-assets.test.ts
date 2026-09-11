/**
 * Worker-pane persona asset tests (issue #315): the default worker command
 * gains the worker persona's deployed prompt override (`--append-system-
 * prompt`) and applied skills (`--skill`) — recorded on the session so
 * relaunch/reconcile re-run the identical command. An explicit `command`
 * option still wins, and with no assets the command is discovery-off pi
 * (issue #356; issue #439: no shipped integration skills ride along).
 *
 * Enforcement (issue #356): pi's global skill discovery is OFF
 * (`--no-skills`) on every PiDeck-launched pane, so a skill restricted to
 * the orchestrator persona cannot leak into a worker pane via
 * `~/.pi/agent/skills` — the per-persona assignment in the store is the
 * single source of truth.
 *
 * The test daemon's context already wires one shared `AgentAssetsStore` into
 * both the session manager and the bootstrap (api/context.ts), so the store
 * under test is `daemon.services.agentAssets` itself.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";

import { testDaemon, type TestDaemon } from "../api/testutil.js";
import { DEFAULT_WORKER_COMMAND, serializeCommand } from "./manager.js";

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
    expect(command).toContain("pi --no-skills");
    expect(command).toContain(
      `--append-system-prompt ${path.join(daemon.stateDir, "agent-assets", "prompts", "worker.md")}`,
    );
    expect(command).toContain(`--skill ${path.join(daemon.stateDir, "agent-assets", "skills", "worker-helper.md")}`);
    expect(command).not.toContain("orchestrator-only");
  });

  it("keeps the shipped-defaults command when no user worker assets are applied", async () => {
    const daemon: TestDaemon = testDaemon();
    const { session } = await daemon.services.sessions.spawnWorker("p1", { issueNumber: 8 });
    // Discovery off; the shipped store seeds ride along — the every-persona
    // using-pideck CLI catalog (issue #463) — and no user shaping.
    expect(session.command).toBe(
      serializeCommand([
        ...DEFAULT_WORKER_COMMAND,
        "--skill", path.join(daemon.stateDir, "agent-assets", "skills", "using-pideck.md"),
      ]),
    );
  });

  it("enforces the persona restriction: an orchestrator-only skill never rides a worker pane (issue #356)", async () => {
    const daemon: TestDaemon = testDaemon();
    const assets = daemon.services.agentAssets;
    // Restricted to the orchestrator (the shipped defaults'
    // out-of-the-box state — issue #338), plus one worker-assigned skill.
    assets.saveSkill("orchestrator-only", { content: "not for workers", personas: ["orchestrator"] });
    assets.saveSkill("worker-helper", { content: "helper skill", personas: ["worker"] });

    const { session } = await daemon.services.sessions.spawnWorker("p1", { issueNumber: 10 });
    const command = session.command ?? "";

    // Discovery off: no `~/.pi/agent/skills` leak path at all…
    expect(command).toContain("--no-skills");
    // …the worker's own assignment loads…
    expect(command).toContain(`--skill ${path.join(daemon.stateDir, "agent-assets", "skills", "worker-helper.md")}`);
    // …and the orchestrator-restricted skill does not appear.
    expect(command).not.toContain(
      `--skill ${path.join(daemon.stateDir, "agent-assets", "skills", "orchestrator-only.md")}`,
    );
    expect(command).not.toContain("orchestrator-only");
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
