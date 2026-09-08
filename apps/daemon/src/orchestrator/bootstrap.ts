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
 * The same machinery also ensures the workspace-level global agent (one
 * per daemon, `SessionManager.ensureGlobalAgent` under the reserved
 * `global` pseudo-project id) with the rendered global-agent prompt — the
 * top of the agent hierarchy (global agent → project orchestrators →
 * workers → review agents), which addresses each project's orchestrator
 * via `pideck send`.
 *
 * Idempotence:
 * - the session itself is `ensureOrchestrator`/`ensureGlobalAgent`'s job
 *   (one per project / per workspace);
 * - pi is only launched when the pane is not already running the agent
 *   (probed via tmux `#{pane_current_command}`), so re-running at every
 *   daemon boot never doubles a live conversation; after a reboot the
 *   reconcile-resurrected plain shell is detected and pi is relaunched.
 *
 * The orchestrator's actions (create issues via the `create-issue` skill,
 * spawn workers via the `spawn-worker` skill → `pideck spawn`) flow
 * through the daemon CLI/API; this module only puts the agent in the pane.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { GLOBAL_AGENT_PROJECT_ID, type Project, type Session } from "@pideck/shared";
import type { ProjectService } from "../api/projects.js";
import { atomicWrite } from "../json-store.js";
import { ProjectLayout } from "../sessions/layout.js";
import { shQuote, type SessionManager } from "../sessions/manager.js";
import type { Tmux } from "../sessions/tmux.js";

import { findAgentPromptPath, renderGlobalAgentPrompt, renderOrchestratorPrompt } from "./prompt.js";

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
 * `PD_SESSION_ID`).
 */
export function orchestratorLaunchCommand(options: { sessionId: string; promptFile: string }): string {
  return [
    "env",
    `PD_SESSION_ID=${shQuote(options.sessionId)}`,
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
  /** Source path of the global-agent prompt template. Default: auto-discovered. */
  globalPromptPath?: string;
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
  private readonly globalPromptPath: string;
  private readonly isAgentRunning: (tmuxSession: string) => Promise<boolean>;
  private readonly onError: (err: unknown, projectId: string) => void;

  constructor(deps: OrchestratorBootstrapDeps) {
    this.sessions = deps.sessions;
    this.tmux = deps.tmux;
    this.layout = deps.layout;
    this.projects = deps.projects;
    this.promptPath = findAgentPromptPath(deps.promptPath);
    this.globalPromptPath = findAgentPromptPath(deps.globalPromptPath, "global-agent.md");
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
    // by the web terminal session picker, issue #7); prompt placeholders
    // rendered per project (issue #12) into the project's state dir.
    return this.ensureAgentPane(
      () => this.sessions.ensureOrchestrator(project.id),
      this.writePromptFile(project),
    );
  }

  /**
   * Ensures the workspace-level global agent session exists and is running
   * the global-agent persona (the top of the hierarchy: it addresses each
   * project's orchestrator with `pideck send`). Same idempotence rules as
   * {@link ensureForProject}: the session is `ensureGlobalAgent`'s job
   * (one per workspace); pi is only launched when the pane is not already
   * running the agent.
   */
  async ensureGlobalAgent(): Promise<Session> {
    const promptFile = this.layout.globalAgentPromptFilePath();
    atomicWrite(promptFile, renderGlobalAgentPrompt(readFileSync(this.globalPromptPath, "utf8"), this.layout.root));
    return this.ensureAgentPane(() => this.sessions.ensureGlobalAgent(), promptFile);
  }

  /**
   * Shared ensure tail: with the persona prompt file already written, make
   * sure the session exists and type the pi launch command into the pane —
   * only when the pane is not already running the agent (idempotence).
   */
  private async ensureAgentPane(ensure: () => Promise<Session>, promptFile: string): Promise<Session> {
    const session = await ensure();
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
   * Ensures the global agent first (the hierarchy's top layer) and then the
   * orchestrator of every registered project. Per-project failures are
   * reported through `onError` and do not stop the others.
   */
  async ensureAll(): Promise<Session[]> {
    const sessions: Session[] = [];
    try {
      sessions.push(await this.ensureGlobalAgent());
    } catch (err) {
      this.onError(err, GLOBAL_AGENT_PROJECT_ID);
    }
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
