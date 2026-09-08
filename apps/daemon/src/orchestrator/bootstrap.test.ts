/**
 * Orchestrator bootstrap tests (issue #12), including the end-to-end fake
 * test: a chat message typed into the orchestrator's pane followed by the
 * (simulated) orchestrator invoking the daemon CLI's spawn command reaches
 * the real spawn path — worker + tmux session + registry, all over fake
 * tmux and a real in-process daemon HTTP server.
 */

import { type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { projectSchema, type Project } from "@pideck/shared";

import { createDaemonServer } from "../api/server.js";
import { startContractServer } from "../api/contract-fixtures.js";
import { testDaemon, type TestDaemon } from "../api/testutil.js";
import { DaemonClient } from "../cli/client.js";
import { run } from "../cli/main.js";
import { ProjectLayout } from "../sessions/layout.js";
import { Tmux, type TmuxRunner } from "../sessions/tmux.js";

import { OrchestratorBootstrap, orchestratorLaunchCommand, paneCommandProbe } from "./bootstrap.js";
import { shQuote } from "../sessions/manager.js";

/** Prompt template fixture carrying the documented placeholders (#12). */
const TEMPLATE = [
  "## Orchestrator for {{PROJECT_ID}}",
  "Name: {{PROJECT_NAME}}",
  "Repo: {{PROJECT_REPO_URL}}",
  "Default branch: {{PROJECT_DEFAULT_BRANCH}}",
  "Path: {{PROJECT_PATH}}",
  "",
].join("\n");

/** Global-agent template fixture: the workspace-level persona's placeholder. */
const GLOBAL_TEMPLATE = [
  "## PiDeck Global Agent",
  "Workspace path: {{WORKSPACE_PATH}}",
  "",
].join("\n");

interface Harness {
  daemon: TestDaemon;
  bootstrap: OrchestratorBootstrap;
  project: Project;
  promptFile: string;
}

async function harness(options: { isAgentRunning?: (tmuxSession: string) => Promise<boolean> } = {}): Promise<Harness> {
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
  });
  return {
    daemon,
    bootstrap,
    project,
    promptFile: path.join(daemon.stateDir, "projects", project.id, "orchestrator-prompt.md"),
  };
}

function orchestratorSessions(daemon: TestDaemon): number {
  return daemon.services.sessions.listSessions().filter((s) => s.role === "orchestrator").length;
}

describe("OrchestratorBootstrap.ensureForProject", () => {
  it("creates the orchestrator session, renders the prompt file and launches pi", async () => {
    const h = await harness();
    const session = await h.bootstrap.ensureForProject(h.project);

    // Exactly one orchestrator session for the project, registered (the web
    // terminal session picker lists registry sessions).
    expect(orchestratorSessions(h.daemon)).toBe(1);
    expect(h.daemon.services.registry.getSession(session.id)?.role).toBe("orchestrator");

    // Rendered prompt: every documented placeholder substituted.
    const rendered = readFileSync(h.promptFile, "utf8");
    expect(rendered).toContain(`Orchestrator for ${h.project.id}`);
    expect(rendered).toContain("Repo: https://github.com/o/r");
    expect(rendered).toContain("Default branch: main");
    expect(rendered).toContain(`Path: ${path.join(h.daemon.stateDir, "projects", h.project.id, "clone")}`);
    expect(rendered).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);

    // pi launched in the pane with the rendered prompt + its session id.
    const pane = h.daemon.tmux.sessions.get(session.tmuxSession);
    expect(pane?.paneLines).toEqual([
      orchestratorLaunchCommand({ sessionId: session.id, promptFile: h.promptFile }),
    ]);
    expect(pane?.paneLines[0]).toContain("--append-system-prompt");
    expect(pane?.paneLines[0]).toContain(`PD_SESSION_ID=${shQuote(session.id)}`);
    expect(pane?.paneLines[0]).toContain("pi");
  });

  it("keeps exactly one orchestrator session across repeated runs", async () => {
    // Second run sees a live agent in the pane: no double launch.
    let probeCalls = 0;
    const h = await harness({
      isAgentRunning: async () => {
        probeCalls++;
        return probeCalls > 1;
      },
    });
    const first = await h.bootstrap.ensureForProject(h.project);
    const second = await h.bootstrap.ensureForProject(h.project);

    expect(second.id).toBe(first.id);
    expect(orchestratorSessions(h.daemon)).toBe(1);
    const pane = h.daemon.tmux.sessions.get(first.tmuxSession);
    expect(pane?.paneLines).toHaveLength(1); // launch keys sent exactly once
  });

  it("relaunches the agent in a resurrected (shell-only) pane", async () => {
    // After a reboot reconcile resurrects the pane as a plain shell: the
    // probe reports no agent, so the boot run relaunches pi. The session is
    // still the same one — never a second orchestrator session.
    const h = await harness({ isAgentRunning: async () => false });
    const first = await h.bootstrap.ensureForProject(h.project);
    const second = await h.bootstrap.ensureForProject(h.project);
    expect(second.id).toBe(first.id);
    expect(orchestratorSessions(h.daemon)).toBe(1);
    expect(h.daemon.tmux.sessions.get(first.tmuxSession)?.paneLines).toHaveLength(2);
  });

  it("ensureAll covers every registered project and tolerates failures", async () => {
    const daemon = testDaemon();
    const a = await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/a" });
    const b = await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/b" });
    const errors: string[] = [];
    mkdirSync(path.join(daemon.stateDir, "fixtures"), { recursive: true });
    writeFileSync(path.join(daemon.stateDir, "fixtures", "global-agent.md"), GLOBAL_TEMPLATE);
    const bootstrap = new OrchestratorBootstrap({
      sessions: daemon.services.sessions,
      tmux: daemon.services.tmux,
      layout: new ProjectLayout(daemon.stateDir),
      projects: daemon.services.projects,
      promptPath: "/nonexistent/template.md", // every project fails to render
      globalPromptPath: path.join(daemon.stateDir, "fixtures", "global-agent.md"),
      onError: (err, projectId) => errors.push(`${projectId}: ${err instanceof Error ? err.message : String(err)}`),
    });
    // The per-project template is deliberately broken, so only the global
    // agent (the hierarchy's top layer, ensured first) comes back.
    const sessions = await bootstrap.ensureAll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.projectId).toBe("global");
    expect(sessions[0]?.role).toBe("orchestrator");
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.split(":")[0])).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it("ensureAll reports the global agent's failure without stopping the projects", async () => {
    const daemon = testDaemon();
    await daemon.services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/a" });
    const errors: string[] = [];
    const promptPath = path.join(daemon.stateDir, "fixtures", "orchestrator.md");
    mkdirSync(path.dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, TEMPLATE);
    const bootstrap = new OrchestratorBootstrap({
      sessions: daemon.services.sessions,
      tmux: daemon.services.tmux,
      layout: new ProjectLayout(daemon.stateDir),
      projects: daemon.services.projects,
      promptPath,
      globalPromptPath: "/nonexistent/global-agent.md", // the global agent fails to render
      onError: (err, projectId) => errors.push(`${projectId}: ${err instanceof Error ? err.message : String(err)}`),
    });
    const sessions = await bootstrap.ensureAll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.projectId).toBe("o-a");
    expect(errors).toEqual([expect.stringContaining("global:")]);
  });
});

describe("OrchestratorBootstrap.ensureGlobalAgent", () => {
  it("creates the workspace-level global agent with the rendered prompt in the state dir", async () => {
    const h = await harness();
    const session = await h.bootstrap.ensureGlobalAgent();

    expect(session.projectId).toBe("global");
    expect(session.role).toBe("orchestrator");
    expect(session.cwd).toBe(h.daemon.stateDir); // the workspace root, not a project dir

    const promptFile = path.join(h.daemon.stateDir, "global-agent-prompt.md");
    const rendered = readFileSync(promptFile, "utf8");
    expect(rendered).toContain(`Workspace path: ${h.daemon.stateDir}`);
    expect(rendered).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);

    const pane = h.daemon.tmux.sessions.get(session.tmuxSession);
    expect(pane?.paneLines).toEqual([orchestratorLaunchCommand({ sessionId: session.id, promptFile })]);
    expect(pane?.paneLines[0]).toContain("pi --append-system-prompt");
  });

  it("is idempotent: one global agent across repeated runs", async () => {
    let probeCalls = 0;
    const h = await harness({
      isAgentRunning: async () => {
        probeCalls++;
        return probeCalls > 1;
      },
    });
    const first = await h.bootstrap.ensureGlobalAgent();
    const second = await h.bootstrap.ensureGlobalAgent();
    expect(second.id).toBe(first.id);
    expect(h.daemon.tmux.sessions.get(first.tmuxSession)?.paneLines).toHaveLength(1); // launched exactly once
  });
});

describe("paneCommandProbe (default agent probe)", () => {
  function tmuxAnswering(output: string): Tmux {
    return new Tmux({
      runner: (async () => ({ stdout: output, stderr: "" })) as TmuxRunner,
    });
  }

  it("treats pi/node panes as running, others not", async () => {
    expect(await paneCommandProbe(tmuxAnswering("node\n"), "s")).toBe(true);
    expect(await paneCommandProbe(tmuxAnswering("pi"), "s")).toBe(true);
    expect(await paneCommandProbe(tmuxAnswering("bash\n"), "s")).toBe(false);
  });

  it("treats a failed probe as not running", async () => {
    const failing = new Tmux({
      runner: async () => {
        throw new Error("unsupported");
      },
    });
    expect(await paneCommandProbe(failing, "s")).toBe(false);
  });
});

describe("end-to-end: chat-requested spawn reaches the daemon spawn path", () => {
  let server: Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
    vi.restoreAllMocks();
  });

  function listen(s: Server): Promise<number> {
    return new Promise((resolve, reject) => {
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port));
    });
  }

  it("orchestrator chat → pideck spawn → worker running in tmux", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {}); // silence CLI JSON output
    const h = await harness();

    // The daemon's HTTP API (the CLI's backing surface) over the same
    // fake-tmux context the orchestrator bootstrap used.
    const { server: httpServer } = createDaemonServer({ services: h.daemon.services, webDist: null });
    server = httpServer;
    const port = await listen(httpServer);

    // 1. The orchestrator session is up (bootstrap ran; pi "running").
    const orch = await h.bootstrap.ensureForProject(h.project);

    // 2. The owner asks the orchestrator, in its terminal, to spawn a
    //    worker (tmux sendKeys / daemon send — PRD: all chat via tmux).
    await h.daemon.services.sessions.sendKeys(
      orch.id,
      "Please spawn a worker for issue #5.",
      { enter: true },
    );
    const pane = h.daemon.tmux.sessions.get(orch.tmuxSession);
    expect(pane?.paneLines.at(-1)).toContain("Please spawn a worker for issue #5.");

    // 3. The orchestrator agent answers by invoking the spawn-worker
    //    skill's pinned CLI invocation (agent/skills/spawn-worker). This is
    //    the real CLI's spawn path over the real HTTP API — fake CLI exec.
    const exit = await run(
      ["spawn", "--project", h.project.id, "--issue", "5", "--name", "issue-5"],
      new DaemonClient(`http://127.0.0.1:${port}`),
    );
    expect(exit).toBe(0);

    // 4. The spawn actually happened through the daemon: worker registered
    //    for the issue, pi launched in its own tmux session, kanban-tracked.
    const workers = h.daemon.services.sessions.listWorkers({ projectId: h.project.id });
    expect(workers).toHaveLength(1);
    expect(workers[0]?.issueNumber).toBe(5);
    expect(workers[0]?.status).toBe("running");
    expect(workers[0]?.sessionId).toBe(
      h.daemon.services.sessions.listSessions(h.project.id).find((s) => s.role === "worker")?.id,
    );

    const workerSessions = [...h.daemon.tmux.sessions.entries()].filter(([name]) => name.endsWith("-worker-1"));
    expect(workerSessions).toHaveLength(1);
    expect(workerSessions[0]?.[1].command).toEqual(["pi"]);

    // 5. The orchestrator session itself is untouched: still exactly one,
    //    and the worker is a separate session in the same project.
    expect(orchestratorSessions(h.daemon)).toBe(1);
    expect(h.daemon.tmux.sessions.size).toBe(2);
  });
});

describe("webapp project registration (issue #166)", () => {
  it("POST /api/projects ends with pi + persona running in the orchestrator pane", async () => {
    // The daemon startup sweep only covers projects known at boot; a
    // mid-run registration (the webapp wizard's POST /api/projects) must
    // trigger the orchestrator bootstrap itself — not leave a bare shell.
    const { daemon, api, close } = await startContractServer();
    try {
      const res = await api("POST", "/api/projects", { mode: "clone", repoUrl: "https://github.com/o/r" });
      expect(res.status).toBe(200);
      const project = projectSchema.parse(res.json);

      const orchestrator = daemon.services.sessions
        .listSessions(project.id)
        .find((s) => s.role === "orchestrator");
      expect(orchestrator).toBeDefined();

      // The pane is not a plain interactive shell: the launch command (pi
      // with the rendered persona prompt + its session id) was typed in.
      const pane = daemon.tmux.sessions.get(orchestrator?.tmuxSession ?? "");
      expect(pane?.paneLines).toHaveLength(1);
      expect(pane?.paneLines[0]).toContain("PD_SESSION_ID=");
      expect(pane?.paneLines[0]).toContain("pi --append-system-prompt");
    } finally {
      await close();
    }
  });
});
