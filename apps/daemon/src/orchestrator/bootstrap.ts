/**
 * Orchestrator bootstrap (issue #12).
 *
 * For every registered project this ensures the one-per-project
 * orchestrator session exists (`SessionManager.ensureOrchestrator`, which
 * creates + registers the tmux session and registry record the web
 * terminal session picker lists) and launches the pi coding agent inside
 * its pane with the rendered orchestrator prompt
 * (`pi --append-system-prompt <rendered prompt file>`).
 *
 * Idempotence:
 * - the session itself is `ensureOrchestrator`'s job (one per project);
 * - pi is only launched when the pane is not already running the agent
 *   (probed via tmux `#{pane_current_command}`), so re-running at every
 *   daemon boot never doubles a live conversation; after a reboot the
 *   reconcile-resurrected plain shell is detected and pi is relaunched.
 *
 * The orchestrator's actions (create issues via the `create-issue` skill,
 * spawn workers via the `spawn-worker` skill → `agentskiss spawn`) flow
 * through the daemon CLI/API; this module only puts the agent in the pane.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import type { DaemonServices } from "../api/context.js";
import type { ProjectService } from "../api/projects.js";
import { atomicWrite } from "../json-store.js";
import { ProjectLayout } from "../sessions/layout.js";
import { shQuote, type SessionManager } from "../sessions/manager.js";
import type { Project, Session } from "@agentskiss/shared";
import type { Tmux } from "../sessions/tmux.js";

import { findAgentPromptPath, renderOrchestratorPrompt } from "./prompt.js";

/** Rendered prompt file written into the project's state dir. */
export const ORCHESTRATOR_PROMPT_FILENAME = "orchestrator-prompt.md";

/**
 * Pane commands that count as "the orchestrator agent is already running".
 * pi is a node program, so tmux reports `node` (or `pi` via a wrapper).
 */
const AGENT_PANE_COMMANDS = new Set(["pi", "node"]);

/**
 * Builds the shell line typed into a fresh orchestrator pane: run pi with
 * the rendered prompt appended to its system prompt and its own session id
 * in the environment (agent/README.md: every agent session gets
 * `AGENTSKISS_SESSION_ID`).
 */
export function orchestratorLaunchCommand(options: { sessionId: string; promptFile: string }): string {
  return [
    "env",
    `AGENTSKISS_SESSION_ID=${shQuote(options.sessionId)}`,
    "pi",
    "--append-system-prompt",
    shQuote(options.promptFile),
  ].join(" ");
}

export interface OrchestratorBootstrapDeps {
  sessions: SessionManager;
  tmux: Tmux;
  layout: ProjectLayout;
  projects: ProjectService;
  /** Source path of the orchestrator prompt template. Default: auto-discovered. */
  promptPath?: string;
  /**
   * Whether the orchestrator pane is already running the agent. Default:
   * tmux `#{pane_current_command}` probe (errors treated as "not running").
   */
  isAgentRunning?: (tmuxSession: string) => Promise<boolean>;
  /** Error sink for per-project failures. Default: console.error. */
  onError?: (err: unknown, projectId: string) => void;
}

/**
 * Default agent-running probe: asks tmux which command the pane is
 * currently running. A failed probe (e.g. a tmux version that does not
 * support the format) conservatively reports "not running".
 */
export async function paneCommandProbe(tmux: Tmux, tmuxSession: string): Promise<boolean> {
  try {
    const { stdout } = await tmux.run([
      "display-message",
      "-p",
      "-t",
      tmuxSession,
      "#{pane_current_command}",
    ]);
    return AGENT_PANE_COMMANDS.has(stdout.trim());
  } catch {
    return false;
  }
}

export class OrchestratorBootstrap {
  private readonly sessions: SessionManager;
  private readonly tmux: Tmux;
  private readonly layout: ProjectLayout;
  private readonly projects: ProjectService;
  private readonly promptPath: string;
  private readonly isAgentRunning: (tmuxSession: string) => Promise<boolean>;
  private readonly onError: (err: unknown, projectId: string) => void;

  constructor(deps: OrchestratorBootstrapDeps) {
    this.sessions = deps.sessions;
    this.tmux = deps.tmux;
    this.layout = deps.layout;
    this.projects = deps.projects;
    this.promptPath = findAgentPromptPath(deps.promptPath);
    this.isAgentRunning = deps.isAgentRunning ?? ((name) => paneCommandProbe(this.tmux, name));
    this.onError = deps.onError ?? ((err, projectId) => {
      console.error(`[daemon] orchestrator bootstrap failed for project "${projectId}":`, err);
    });
  }

  /**
   * Ensures the project's orchestrator session exists and is running the
   * orchestrator persona. Returns the orchestrator session.
   */
  async ensureForProject(project: Project): Promise<Session> {
    // One orchestrator tmux session + registry record per project (listed
    // by the web terminal session picker, issue #7).
    const session = await this.sessions.ensureOrchestrator(project.id);

    // Render the prompt placeholders (issue #12) into the project's state
    // dir; pi reads the file via --append-system-prompt.
    const promptFile = this.writePromptFile(project);

    if (!(await this.isAgentRunning(session.tmuxSession))) {
      await this.tmux.sendKeys(
        session.tmuxSession,
        orchestratorLaunchCommand({ sessionId: session.id, promptFile }),
        { enter: true },
      );
    }
    return session;
  }

  /**
   * Ensures orchestrators for every registered project. Per-project
   * failures are reported through `onError` and do not stop the others.
   */
  async ensureAll(): Promise<Session[]> {
    const sessions: Session[] = [];
    for (const project of this.projects.list()) {
      try {
        sessions.push(await this.ensureForProject(project));
      } catch (err) {
        this.onError(err, project.id);
      }
    }
    return sessions;
  }

  /** Renders + writes the per-project prompt file; returns its path. */
  private writePromptFile(project: Project): string {
    const template = readFileSync(this.promptPath, "utf8");
    const content = renderOrchestratorPrompt(template, project, this.layout.cloneDir(project.id));
    const file = path.join(this.layout.projectDir(project.id), ORCHESTRATOR_PROMPT_FILENAME);
    atomicWrite(file, content);
    return file;
  }
}

/**
 * Boot hook for the daemon entry point (`apps/daemon/src/index.ts`):
 * ensures one running orchestrator per registered project. Call once after
 * startup session reconciliation so resurrected orchestrator panes get
 * their agent relaunched.
 *
 * `layout` defaults to the state-dir layout derived from `AGENTSKISS_HOME`
 * (the daemon entry point uses the same default); tests inject the exact
 * {@link ProjectLayout} of their context.
 */
export async function ensureProjectOrchestrators(
  services: DaemonServices,
  options: Partial<Pick<OrchestratorBootstrapDeps, "layout" | "promptPath" | "isAgentRunning" | "onError">> = {},
): Promise<Session[]> {
  const bootstrap = new OrchestratorBootstrap({
    sessions: services.sessions,
    tmux: services.tmux,
    projects: services.projects,
    layout: options.layout ?? new ProjectLayout(),
    promptPath: options.promptPath,
    isAgentRunning: options.isAgentRunning,
    onError: options.onError,
  });
  return bootstrap.ensureAll();
}
