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
 * The orchestrator's actions (issue filing via `gh`, worker spawns via
 * `pideck spawn`) flow through the daemon CLI/API; this module only puts
 * the agent in the pane.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { GLOBAL_AGENT_PROJECT_ID, type AgentKindSpec, type Persona, type Project, type Session } from "@pideck/shared";
import type { ProjectService } from "../api/projects.js";
import type { PersonaLaunchAssets } from "../api/agent-assets.js";
import { atomicWrite } from "../json-store.js";
import { agentKindLaunchCommand, agentKindPromptFilePath, AgentKindRegistry } from "../sessions/agent-kinds.js";
import { ProjectLayout } from "../sessions/layout.js";
import { serializeCommand, shQuote, type SessionManager } from "../sessions/manager.js";
import type { Tmux } from "../sessions/tmux.js";

import { findAgentPromptPath, orchestratorPromptValues, renderGlobalAgentPrompt, renderOrchestratorPrompt, renderTemplate } from "./prompt.js";

/** Rendered prompt file written into the project's state dir. */
const ORCHESTRATOR_PROMPT_FILENAME = "orchestrator-prompt.md";

/**
 * Pane commands that count as "the orchestrator agent is already running".
 * pi is a node program, so tmux reports `node` (or `pi` via a wrapper).
 */
const AGENT_PANE_COMMANDS = new Set(["pi", "node"]);

/**
 * Builds the shell line typed into a fresh orchestrator-pane persona: run pi
 * with the rendered prompt appended to its system prompt, its own session id
 * in the environment (agent/README.md: every agent session gets
 * `PD_SESSION_ID`), and the user skills applied to the persona (issue #315)
 * surfaced via `--skill <file>`. Discovery is off (`--no-skills`, issue
 * #356): the per-persona assignment is the single source of truth for store
 * skills, so pi's global skill locations (e.g. the installer's
 * `~/.pi/agent/skills/` symlinks, visible to every session on the machine)
 * must not leak other personas' skills into the pane.
 *
 * PiDeck ships no ride-every-pane integration skills (issue #439): the
 * panes' `--skill` args are exactly the persona's assigned store skills.
 */
export function orchestratorLaunchCommand(options: { sessionId: string; promptFile: string; skillArgs?: string[] }): string {
  return [
    "env",
    `PD_SESSION_ID=${shQuote(options.sessionId)}`,
    "pi",
    "--no-skills",
    "--append-system-prompt",
    shQuote(options.promptFile),
    ...(options.skillArgs ?? []),
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
   * Per-persona user assets (issue #315): prompt overrides take precedence
   * over the shipped templates; applied skills ride the launch lines as
   * `--skill <file>`. Absent (default): shipped defaults, no persona
   * shaping (panes still run with discovery off — issue #356).
   */
  agentAssets?: PersonaLaunchAssets;
  /**
   * Agent-kind registry (v2, issue #330): kind specs for
   * `ensureAgentKindSession` resolve from here. Absent (default): the
   * shipped built-ins only — user kinds need the store-backed registry.
   */
  agentKinds?: AgentKindRegistry;
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
  private readonly agentAssets: PersonaLaunchAssets | undefined;
  private readonly agentKinds: AgentKindRegistry;
  private readonly isAgentRunning: (tmuxSession: string) => Promise<boolean>;
  private readonly onError: (err: unknown, projectId: string) => void;

  constructor(deps: OrchestratorBootstrapDeps) {
    this.sessions = deps.sessions;
    this.tmux = deps.tmux;
    this.layout = deps.layout;
    this.projects = deps.projects;
    this.promptPath = findAgentPromptPath(deps.promptPath);
    this.globalPromptPath = findAgentPromptPath(deps.globalPromptPath, "global-agent.md");
    this.agentAssets = deps.agentAssets;
    this.agentKinds = deps.agentKinds ?? new AgentKindRegistry();
    this.isAgentRunning = deps.isAgentRunning ?? ((name) => paneCommandProbe(this.tmux, name));
    this.onError = deps.onError ?? ((err, projectId) => {
      console.error(`[daemon] orchestrator bootstrap failed for project "${projectId}":`, err);
    });
  }

  /**
   * Ensures the project's orchestrator session exists and is running the
   * orchestrator persona. Returns the orchestrator session. The user's
   * prompt override (issue #315), when stored, replaces the shipped
   * template; applied skills ride the launch line via `--skill`.
   */
  async ensureForProject(project: Project): Promise<Session> {
    // One orchestrator tmux session + registry record per project (listed
    // by the web terminal session picker, issue #7); prompt placeholders
    // rendered per project (issue #12) into the project's state dir.
    return this.ensureAgentPane(
      () => this.sessions.ensureOrchestrator(project.id),
      this.writePromptFile(project, "orchestrator"),
      this.personaLaunchLine("orchestrator"),
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
    const template = this.agentAssets?.promptOverride("global-agent") ?? readFileSync(this.globalPromptPath, "utf8");
    const promptFile = this.layout.globalAgentPromptFilePath();
    atomicWrite(promptFile, renderGlobalAgentPrompt(template, this.layout.root));
    return this.ensureAgentPane(() => this.sessions.ensureGlobalAgent(), promptFile, this.personaLaunchLine("global-agent"));
  }

  /**
   * Shared ensure tail: with the persona prompt file already written, make
   * sure the session exists and type the pi launch command into the pane —
   * only when the pane is not already running the agent (idempotence).
   * `launchLine` (session id + prompt file → shell line) lets each persona
   * shape its own pi command (agent-kind file/tool/skill args, issue #315
   * skill args); it defaults to the orchestrator launch command.
   */
  private async ensureAgentPane(ensure: () => Promise<Session>, promptFile: string, launchLine?: (sessionId: string, promptFile: string) => string): Promise<Session> {
    const session = await ensure();
    if (!(await this.isAgentRunning(session.tmuxSession))) {
      await this.tmux.sendKeys(
        session.tmuxSession,
        launchLine?.(session.id, promptFile) ?? orchestratorLaunchCommand({ sessionId: session.id, promptFile }),
        { enter: true },
      );
    }
    return session;
  }

  /**
   * The orchestrator-pane launch line for one persona (orchestrator or
   * global agent): pi with the rendered prompt file plus the persona's
   * applied user skills (issue #315 — discovery is off, so they ride the
   * line explicitly; issue #439: no shipped globals ride along).
   */
  private personaLaunchLine(persona: Persona): (sessionId: string, promptFile: string) => string {
    return (sessionId, promptFile) =>
      orchestratorLaunchCommand({
        sessionId,
        promptFile,
        skillArgs: this.skillLaunchArgs(persona),
      });
  }

  /**
   * The full `--skill` argv for a persona's pane: the store skills assigned
   * to the persona (issue #315). PiDeck ships no ride-every-pane skills
   * (issue #439) — the per-persona assignment is the only skill source.
   */
  private skillLaunchArgs(persona: string): string[] {
    return this.agentAssets?.skillLaunchArgs(persona) ?? [];
  }

  /**
   * Re-launches the agent persona in a freshly (re)created pane (issue
   * #290): the relaunch/reconcile launch paths recreate orchestrator and
   * agent-kind panes as bare shells — putting pi back with the persona is
   * the bootstrap's job (this module's issue #12 machinery), so a
   * relaunched agent is identical to a fresh boot: same rendered persona
   * prompt, session id env, and workspace. Dispatches on the session: the
   * global agent re-ensures the global persona, a project orchestrator
   * re-ensures the project's, an agent-kind session (docs/agent-kinds.md)
   * re-ensures its kind persona. Returns `null` for plain worker sessions
   * (their relaunch re-runs their recorded command, issue #27) and for
   * sessions whose project is unknown. Idempotent: the pane probe skips
   * the launch when the agent is already running.
   */
  async ensureForSession(session: Session): Promise<Session | null> {
    if (session.agentKind !== undefined) return this.ensureAgentKindSession(session);
    if (session.role !== "orchestrator") return null;
    if (session.projectId === GLOBAL_AGENT_PROJECT_ID) return this.ensureGlobalAgent();
    const project = this.projects.get(session.projectId);
    if (project === undefined) return null;
    return this.ensureForProject(project);
  }

  /**
   * Puts pi back into an agent-kind session's bare-shell pane
   * (docs/agent-kinds.md, issue #310): renders the kind persona
   * (`agent/prompts/<kind>.md` — or the persona's user override, issue #315)
   * with the project placeholders, the recorded parent lineage
   * (`{{PARENT_SESSION_ID}}`), and the live project orchestrator for
   * orchestrator-routed kinds (`{{ORCHESTRATOR_SESSION_ID}}`), writes it next
   * to the project state, and types the launch line (`env PD_SESSION_ID=… pi
   * --append-system-prompt <file>` — the persona's applied user skills via
   * `--skill`, write tools excluded for read-only kinds) into the pane —
   * only when the pane is not already running the agent (the same
   * idempotence probe as orchestrator panes). Returns `null` for sessions
   * whose project is unknown.
   */
  async ensureAgentKindSession(session: Session): Promise<Session | null> {
    if (session.agentKind === undefined) return null;
    // Issue #357 B9: archived persona agents are history — never re-launch
    // their persona into a pane (the startup sweep filters them already;
    // this guards direct callers, e.g. a relaunch racing an archive).
    if (session.archivedAt !== undefined) return null;
    const project = this.projects.get(session.projectId);
    if (project === undefined) return null;
    const kind = session.agentKind;
    const spec: AgentKindSpec | undefined = this.agentKinds.get(kind);
    if (spec === undefined) throw new Error(`unknown agent kind: ${kind}`);
    const orchestrator =
      spec.reportTarget === "orchestrator"
        ? (await this.sessions.ensureOrchestrator(session.projectId)).id
        : (session.parentSessionId ?? "");
    // Persona content precedence (issue #330): the kind's agent-assets
    // override (issue #315, shipped kinds) → the spec's own content (user
    // kinds) → the shipped-default file `agent/prompts/<kind>.md`.
    const template =
      this.agentAssets?.promptOverride(kind) ?? spec.persona ?? readFileSync(findAgentPromptPath(undefined, `${kind}.md`), "utf8");
    const content = renderTemplate(template, {
      ...orchestratorPromptValues(project, session.cwd ?? this.layout.cloneDir(session.projectId)),
      PARENT_SESSION_ID: session.parentSessionId ?? "",
      ...(spec.reportTarget === "orchestrator" ? { ORCHESTRATOR_SESSION_ID: orchestrator } : {}),
    });
    const promptFile = agentKindPromptFilePath(this.layout, session.projectId, session.id);
    atomicWrite(promptFile, content);
    return this.ensureAgentPane(
      async () => session,
      promptFile,
      (sessionId, promptFile) =>
        serializeCommand(
          agentKindLaunchCommand({
            sessionId,
            promptFile,
            spec,
            skillArgs: this.skillLaunchArgs(kind),
          }),
        ),
    );
  }

  /**
   * Ensures the global agent first (the hierarchy's top layer), then the
   * orchestrator of every registered project, then every registered
   * agent-kind session (docs/agent-kinds.md): the startup sweep heals
   * kind panes that reconcile resurrected as bare shells (issue #310 —
   * their launch line is typed, not recorded). Per-session failures are
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
    for (const session of this.sessions.listSessions()) {
      if (session.agentKind === undefined) continue;
      try {
        sessions.push((await this.ensureAgentKindSession(session)) ?? session);
      } catch (err) {
        this.onError(err, session.projectId);
      }
    }
    return sessions;
  }

  /**
   * Renders + writes the per-project prompt file for one persona; the
   * persona's stored override (issue #315) replaces the shipped template.
   * Returns its path.
   */
  private writePromptFile(project: Project, persona: Persona): string {
    const template = this.agentAssets?.promptOverride(persona) ?? readFileSync(this.promptPath, "utf8");
    const content = renderOrchestratorPrompt(template, project, this.layout.cloneDir(project.id));
    const file = path.join(this.layout.projectDir(project.id), ORCHESTRATOR_PROMPT_FILENAME);
    atomicWrite(file, content);
    return file;
  }
}
