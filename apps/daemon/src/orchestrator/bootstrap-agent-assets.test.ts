/**
 * Per-persona asset launch-shaping tests (issue #315): `OrchestratorBootstrap`
 * builds every persona pane's pi launch line — so this is where prompt
 * overrides take precedence and applied skills ride along as `--skill` args,
 * for the orchestrator, global-agent, and agent-kind personas alike. The
 * store is shared with the launch paths in production (api/context.ts); here
 * a real `AgentAssetsStore` over the test daemon's state dir proves the
 * end-to-end precedence behavior.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AgentAssetsStore } from "../api/agent-assets.js";
import { testDaemon } from "../api/testutil.js";
import { ProjectLayout } from "../sessions/layout.js";

import { OrchestratorBootstrap } from "./bootstrap.js";

/** The bootstrap writes the rendered orchestrator prompt under this name (kept in sync with bootstrap.ts). */
const ORCHESTRATOR_PROMPT_FILENAME = "orchestrator-prompt.md";

async function harness() {
  const daemon = testDaemon();
  const project = await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
  const agentAssets = new AgentAssetsStore(daemon.stateDir);
  const bootstrap = new OrchestratorBootstrap({
    sessions: daemon.services.sessions,
    tmux: daemon.services.tmux,
    layout: new ProjectLayout(daemon.stateDir),
    projects: daemon.services.projects,
    agentAssets,
  });
  return { daemon, bootstrap, project, agentAssets };
}

/** The typed launch line in a pane (the bootstrap types one line, then Enter). */
function typedLine(daemon: Awaited<ReturnType<typeof harness>>["daemon"], tmuxSession: string): string {
  const lines = daemon.tmux.sessions.get(tmuxSession)?.paneLines ?? [];
  return lines.join("\n");
}

describe("persona asset launch shaping (issue #315)", () => {
  it("applies a skill and a prompt override to the project orchestrator pane", async () => {
    const h = await harness();
    await h.agentAssets.saveSkill("prd", { content: "---\nname: prd\ndescription: PRD skill\n---\n", personas: ["orchestrator"] });
    await h.agentAssets.saveSkill("worker-only", { content: "not for orchestrators", personas: ["worker"] });
    await h.agentAssets.savePromptOverride("orchestrator", "Custom orchestrator for {{PROJECT_ID}}");

    await h.bootstrap.ensureForProject(h.project);

    const orchestrator = h.daemon.services.sessions.listSessions(h.project.id).find((s) => s.role === "orchestrator");
    expect(orchestrator).toBeDefined();
    const line = typedLine(h.daemon, orchestrator!.tmuxSession);
    const skillFile = path.join(h.daemon.stateDir, "agent-assets", "skills", "prd.md");
    expect(line).toContain(`--skill ${skillFile}`);
    expect(line).not.toContain("worker-only");
    // The override replaced the shipped template — rendered, placeholders included.
    const rendered = readFileSync(
      path.join(h.daemon.stateDir, "projects", h.project.id, ORCHESTRATOR_PROMPT_FILENAME),
      "utf8",
    );
    expect(rendered).toContain("Custom orchestrator");
    expect(rendered).toContain(h.project.id);
    expect(rendered).not.toContain("{{PROJECT_ID}}");
    expect(rendered).not.toContain("PiDeck Orchestrator Role");
  });

  it("keeps the shipped orchestrator default when no override is stored", async () => {
    const h = await harness();
    await h.bootstrap.ensureForProject(h.project);
    const rendered = readFileSync(
      path.join(h.daemon.stateDir, "projects", h.project.id, ORCHESTRATOR_PROMPT_FILENAME),
      "utf8",
    );
    expect(rendered).toContain("PiDeck Orchestrator Role");
    expect(rendered).toContain(h.project.id);
  });

  it("applies skills to the global-agent pane", async () => {
    const h = await harness();
    await h.agentAssets.saveSkill("top", { content: "for the top of the hierarchy", personas: ["global-agent"] });

    const session = await h.bootstrap.ensureGlobalAgent();

    const line = typedLine(h.daemon, session.tmuxSession);
    expect(line).toContain(`--skill ${path.join(h.daemon.stateDir, "agent-assets", "skills", "top.md")}`);
  });

  it("applies skills and a prompt override to agent-kind panes", async () => {
    const h = await harness();
    await h.agentAssets.saveSkill("audit-help", { content: "audit helper skill", personas: ["kiss-audit", "devex-audit"] });
    await h.agentAssets.saveSkill("worker-only", { content: "not for audits", personas: ["worker"] });
    await h.agentAssets.savePromptOverride("kiss-audit", "Custom KISS audit persona for {{PROJECT_ID}}");

    const audit = await h.daemon.services.sessions.spawnAgentKind(h.project.id, {
      kind: "kiss-audit",
      parentSessionId: "sess-parent-1",
      name: "audit",
    });
    await h.bootstrap.ensureForSession(audit);

    const line = typedLine(h.daemon, audit.tmuxSession);
    expect(line).toContain(`--skill ${path.join(h.daemon.stateDir, "agent-assets", "skills", "audit-help.md")}`);
    expect(line).not.toContain("worker-only");
    expect(line).toContain("--exclude-tools edit,write");

    // The override won over the shipped kiss-audit persona, placeholders rendered.
    const rendered = readFileSync(
      path.join(h.daemon.stateDir, "projects", h.project.id, `agent-prompt-${audit.id}.md`),
      "utf8",
    );
    expect(rendered).toContain("Custom KISS audit persona");
    expect(rendered).not.toContain("{{PROJECT_ID}}");
  });
});
