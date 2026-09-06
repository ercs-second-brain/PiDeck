/**
 * Session manager: the facade the rest of the daemon talks to.
 *
 * Responsibilities (issue #4):
 * - create/list/kill tmux sessions per project, named
 *   `agentskiss-<projectId>-<role>-<n>`
 * - one orchestrator session per project (`ensureOrchestrator`)
 * - worker spawn = launch a pi session in the project's workspace tmux
 *   pane and register it (Session + Worker records from shared contracts)
 * - capture-pane / resize passthroughs keyed by registry session id
 *
 * The orchestrator persona/prompt content itself is issue #12; we only
 * create and track its tmux session here.
 */

import type { Session, Worker, WorkerStatus } from "@agentskiss/shared";
import { ProjectLayout } from "./layout.js";
import type { SessionRegistry, SessionRole } from "./registry.js";
import { Tmux } from "./tmux.js";

/** Command launched in worker panes. The pi coding agent CLI runs interactively in the pane. */
export const DEFAULT_WORKER_COMMAND: string[] = ["pi"];

export interface SpawnWorkerOptions {
  /** Issue the worker is spawned for (recorded on the Worker). */
  issueNumber: number;
  /** Working directory for the worker pane; defaults to the project's clone dir. */
  cwd?: string;
  /** Command to launch; defaults to {@link DEFAULT_WORKER_COMMAND}. */
  command?: string[];
  /** Initial status message once the agent is up. */
  statusMessage?: string;
}

export interface SpawnedWorker {
  session: Session;
  worker: Worker;
}

export class SessionManager {
  private readonly tmux: Tmux;
  private readonly registry: SessionRegistry;
  private readonly layout: ProjectLayout;

  constructor(deps: { tmux: Tmux; registry: SessionRegistry; layout: ProjectLayout }) {
    this.tmux = deps.tmux;
    this.registry = deps.registry;
    this.layout = deps.layout;
  }

  /** Creates the per-project state layout (clone/worktrees dirs). Idempotent. */
  async ensureProject(projectId: string): Promise<void> {
    this.layout.ensureProject(projectId);
  }

  /**
   * Returns the project's orchestrator session, creating its tmux session
   * (and registry record) if none is alive. One per project.
   */
  async ensureOrchestrator(projectId: string): Promise<Session> {
    for (const existing of this.registry.listSessions({ projectId, role: "orchestrator" })) {
      if (await this.tmux.hasSession(existing.tmuxSession)) return existing;
    }
    await this.ensureProject(projectId);
    const name = await this.nextTmuxSessionName(projectId, "orchestrator");
    await this.tmux.newSession(name, { cwd: this.layout.projectDir(projectId) });
    return this.registry.createSession({
      projectId,
      role: "orchestrator",
      tmuxSession: name,
      workerId: null,
    });
  }

  /**
   * Spawns a worker: creates the project layout, opens a tmux session
   * running the pi coding agent in the project's workspace, and registers
   * both the session and the worker.
   */
  async spawnWorker(projectId: string, options: SpawnWorkerOptions): Promise<SpawnedWorker> {
    await this.ensureProject(projectId);
    const name = await this.nextTmuxSessionName(projectId, "worker");
    const cwd = options.cwd ?? this.layout.cloneDir(projectId);
    const command = options.command ?? [...DEFAULT_WORKER_COMMAND];

    const session = this.registry.createSession({
      projectId,
      role: "worker",
      tmuxSession: name,
      workerId: null,
    });
    const worker = this.registry.registerWorker({
      projectId,
      sessionId: session.id,
      issueNumber: options.issueNumber,
      status: "spawning",
      statusMessage: "launching agent session",
    });
    this.registry.setSessionWorker(session.id, worker.id);

    try {
      await this.tmux.newSession(name, { cwd, command });
    } catch (err) {
      this.registry.updateWorkerStatus(
        worker.id,
        "failed",
        `tmux launch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.registry.deleteSession(session.id);
      throw err;
    }

    const running = this.registry.updateWorkerStatus(
      worker.id,
      "running",
      options.statusMessage ?? "agent running in tmux session",
    );
    return {
      session: this.registry.getSession(session.id) as Session,
      worker: running,
    };
  }

  /** Registry sessions (all projects, or one project's). */
  listSessions(projectId?: string): Session[] {
    return this.registry.listSessions(projectId ? { projectId } : {});
  }

  listWorkers(filter: { projectId?: string; status?: WorkerStatus } = {}): Worker[] {
    return this.registry.listWorkers(filter);
  }

  getWorker(workerId: string): Worker | undefined {
    return this.registry.getWorker(workerId);
  }

  updateWorkerStatus(workerId: string, status: WorkerStatus, statusMessage?: string): Worker {
    return this.registry.updateWorkerStatus(workerId, status, statusMessage);
  }

  setWorkerPr(workerId: string, prNumber: number): Worker {
    return this.registry.setWorkerPr(workerId, prNumber);
  }

  /**
   * Kills a registered session's tmux session and removes it from the
   * registry. Any worker attached to it is marked `stopped`. Returns the
   * removed session, or `null` for an unknown id.
   */
  async killSession(sessionId: string): Promise<Session | null> {
    const session = this.registry.getSession(sessionId);
    if (!session) return null;
    if (await this.tmux.hasSession(session.tmuxSession)) {
      await this.tmux.killSession(session.tmuxSession);
    }
    if (session.workerId !== null) {
      const worker = this.registry.getWorker(session.workerId);
      if (worker && worker.status !== "done" && worker.status !== "failed") {
        this.registry.updateWorkerStatus(worker.id, "stopped", "tmux session killed");
      }
    }
    this.registry.deleteSession(session.id);
    return session;
  }

  /** Whether the session's tmux session is still alive. */
  async isAlive(sessionId: string): Promise<boolean> {
    const session = this.registry.getSession(sessionId);
    if (!session) return false;
    return this.tmux.hasSession(session.tmuxSession);
  }

  /** Captures the session pane (visible + up to `lines` of scrollback). */
  async capturePane(sessionId: string, lines?: number): Promise<string> {
    const session = this.requireSession(sessionId);
    return this.tmux.capturePane(session.tmuxSession, { lines });
  }

  /** Resizes the session's window. */
  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.tmux.resize(session.tmuxSession, cols, rows);
  }

  /** Types text into the session's pane (e.g. to answer an agent prompt). */
  async sendKeys(sessionId: string, keys: string, options: { enter?: boolean } = {}): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.tmux.sendKeys(session.tmuxSession, keys, options);
  }

  /**
   * Next free tmux session name for a project+role, considering both live
   * tmux sessions and registry records so names never collide across
   * reloads: `agentskiss-<projectId>-<role>-<n>` with n starting at 1.
   */
  async nextTmuxSessionName(projectId: string, role: SessionRole): Promise<string> {
    const prefix = `agentskiss-${sanitizeTmuxSegment(projectId)}-${role}-`;
    const known = new Set([
      ...(await this.tmux.listSessions()),
      ...this.registry.listSessions().map((s) => s.tmuxSession),
    ]);
    let n = 1;
    while (known.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }

  private requireSession(sessionId: string): Session {
    const session = this.registry.getSession(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    return session;
  }
}

/** Keeps a projectId safe for tmux session names (tmux forbids `.` and `:`). */
export function sanitizeTmuxSegment(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "project";
}
