/**
 * Session manager: the facade the rest of the daemon talks to.
 *
 * Responsibilities (issue #4):
 * - create/list/kill tmux sessions per project, named
 *   `pideck-<projectId>-<role>-<n>`
 * - one orchestrator session per project (`ensureOrchestrator`)
 * - worker spawn = launch a pi session in the project's workspace tmux
 *   pane and register it (Session + Worker records from shared contracts)
 * - capture-pane / resize passthroughs keyed by registry session id
 * - startup reconciliation against live tmux state (issue #15) — the
 *   machinery lives in `reconcile.ts`, worker workspace preparation in
 *   `workspace.ts` (issue #287); this facade delegates to both
 *
 * The orchestrator persona/prompt content itself is issue #12; we only
 * create and track its tmux session here.
 *
 * The command/name helpers this facade leans on (shQuote,
 * serialize/deserializeCommand, the resurrection guard, tmux-name
 * parse/sanitize) live in `tmux-commands.ts` and are re-exported here.
 */

import type { Session, Worker, WorkerKind, WorkerStatus } from "@pideck/shared";
import { GLOBAL_AGENT_PROJECT_ID } from "@pideck/shared";
import { defaultGitRunner, type GitRunner } from "../github/repos.js";
import { ProjectLayout } from "./layout.js";
import { prepareWorkerWorkspace } from "./workspace.js";
import type { SessionRegistry, SessionRole } from "./registry.js";
import { ArchivedLogStore, type ArchivedScrollback } from "./archived-logs.js";
import { isArchivedWorkerSession, isTerminalWorkerStatus, launchPath, reconcileSessions, type ReconcileDeps, type ReconcileResult } from "./reconcile.js";
import { Tmux } from "./tmux.js";
import { DEFAULT_WORKER_COMMAND, sanitizeTmuxSegment, serializeCommand } from "./tmux-commands.js";

export { type ReconcileResult } from "./reconcile.js";

export {
  DEFAULT_WORKER_COMMAND,
  RESURRECT_WORKER_COMMAND,
  deserializeCommand,
  parseTmuxSessionName,
  resurrectionCommand,
  sanitizeTmuxSegment,
  serializeCommand,
  shQuote,
} from "./tmux-commands.js";

export interface SpawnWorkerOptions {
  /** Issue the worker is spawned for (recorded on the Worker). */
  issueNumber: number;
  /**
   * Working directory for the worker pane. When omitted (the default), the
   * daemon prepares a fresh per-worker workspace: a git worktree branched
   * off origin's current default-branch HEAD (issue #287). An explicit cwd
   * is caller-owned and used as-is.
   */
  cwd?: string;
  /** Command to launch; defaults to {@link DEFAULT_WORKER_COMMAND}. */
  command?: string[];
  /** Initial status message once the agent is up. */
  statusMessage?: string;
  /** Worker kind (issue #107); omit for implementers — absent means implementer. */
  kind?: WorkerKind;
  /** Parent worker for nested spawns (review agents, issue #107). */
  parentWorkerId?: string | null;
  /** PR the worker owns or reviews (review agents, issue #107). */
  prNumber?: number;
  /** Initial prompt typed into the pane at spawn; persisted on the worker (issue #120). */
  prompt?: string;
}

export interface SpawnedWorker {
  session: Session;
  worker: Worker;
}

/**
 * How much scrollback to capture when archiving a worker (issue #104): the
 * tmux server's default history limit, so a full pane history fits.
 */
const ARCHIVED_SCROLLBACK_LINES = 2000;

export class SessionManager {
  private readonly tmux: Tmux;
  private readonly registry: SessionRegistry;
  private readonly layout: ProjectLayout;
  private readonly archivedLogs: ArchivedLogStore;
  private readonly git: GitRunner;
  /** Collaborators for the extracted reconcile machinery (reconcile.ts). */
  private readonly deps: ReconcileDeps;

  constructor(deps: {
    tmux: Tmux;
    registry: SessionRegistry;
    layout: ProjectLayout;
    /** Archived-scrollback store (issue #104); defaults to the state-dir file. */
    archivedLogs?: ArchivedLogStore;
    /** Git runner for worker workspace preparation (issue #287); defaults to the real git binary. */
    git?: GitRunner;
  }) {
    this.tmux = deps.tmux;
    this.registry = deps.registry;
    this.layout = deps.layout;
    this.git = deps.git ?? defaultGitRunner;
    this.deps = { tmux: deps.tmux, registry: deps.registry, layout: deps.layout };
    this.archivedLogs = deps.archivedLogs ?? new ArchivedLogStore(deps.layout.archivedLogsFilePath());
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
    this.ensureProject(projectId);
    return this.ensureOrchestratorSession(projectId, this.layout.projectDir(projectId));
  }

  /**
   * Returns the workspace-level global agent session (the top of the agent
   * hierarchy: global agent → project orchestrators → workers → review
   * agents), creating its tmux session (and registry record) if none is
   * alive. One per workspace; modeled as an orchestrator-role session under
   * the reserved `GLOBAL_AGENT_PROJECT_ID` pseudo-project so registry
   * persistence, reconcile/adoption, the terminal bridge, relaunch, and
   * `pideck send` all work unchanged. Its pane runs in the daemon state dir
   * root — the workspace spanning every project — not in any project dir.
   */
  async ensureGlobalAgent(): Promise<Session> {
    return this.ensureOrchestratorSession(GLOBAL_AGENT_PROJECT_ID, this.layout.root);
  }

  /**
   * Shared find-or-create for orchestrator-role sessions (per-project
   * orchestrators and the global agent): reuse the live session when one
   * exists, else open a fresh `pideck-<projectId>-orchestrator-<n>` tmux
   * session in the given cwd.
   */
  private async ensureOrchestratorSession(projectId: string, cwd: string): Promise<Session> {
    for (const existing of this.registry.listSessions({ projectId, role: "orchestrator" })) {
      if (await this.tmux.hasSession(existing.tmuxSession)) return existing;
    }
    const name = await this.nextTmuxSessionName(projectId, "orchestrator");
    await this.tmux.newSession(name, { cwd });
    return this.registry.createSession({
      projectId,
      role: "orchestrator",
      tmuxSession: name,
      cwd,
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

    const session = this.registry.createSession({
      projectId,
      role: "worker",
      tmuxSession: name,
      // Record what is actually launched so reconcile() can resurrect the
      // same pane after a daemon restart or reboot (issue #27). For the
      // default path the cwd is patched after workspace preparation below
      // (issue #287); an explicit cwd is recorded as-is.
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      command: serializeCommand(options.command ?? [...DEFAULT_WORKER_COMMAND]),
      workerId: null,
    });
    const worker = this.registry.registerWorker({
      projectId,
      sessionId: session.id,
      issueNumber: options.issueNumber,
      status: "spawning",
      statusMessage: "launching agent session",
      ...(options.prNumber !== undefined ? { prNumber: options.prNumber } : {}),
      ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
      ...(options.kind !== undefined ? { kind: options.kind } : {}),
      ...(options.parentWorkerId !== undefined ? { parentWorkerId: options.parentWorkerId } : {}),
    });
    this.registry.setSessionWorker(session.id, worker.id);

    // Issue #287: default-path workers start in a fresh per-worker worktree
    // (named after the worker) branched off origin's current default branch.
    // A fetch failure aborts the spawn — never start work on a stale base.
    // An explicit cwd is caller-owned and used as-is.
    let workspace: { path: string; discard: () => Promise<void> } | null;
    let cwd: string;
    try {
      if (options.cwd === undefined) {
        workspace = await prepareWorkerWorkspace(this.git, this.layout, projectId, worker.id);
        this.registry.setSessionCwd(session.id, workspace.path);
        cwd = workspace.path;
      } else {
        workspace = null;
        cwd = options.cwd;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.registry.updateWorkerStatus(worker.id, "failed", `workspace preparation failed: ${reason}`);
      this.registry.deleteSession(session.id);
      throw err;
    }
    const command = options.command ?? [...DEFAULT_WORKER_COMMAND];

    try {
      await this.tmux.newSession(name, { cwd, command });
    } catch (err) {
      this.registry.updateWorkerStatus(worker.id, "failed", `tmux launch failed: ${err instanceof Error ? err.message : String(err)}`);
      this.registry.deleteSession(session.id);
      if (workspace !== null) await workspace.discard();
      throw err;
    }

    const running = this.registry.updateWorkerStatus(worker.id, "running", options.statusMessage ?? "agent running in tmux session");
    return {
      session: this.registry.getSession(session.id) as Session,
      worker: running,
    };
  }

  /** The registry session for `sessionId`, or `undefined` when unknown. */
  getSession(sessionId: string): Session | undefined {
    return this.registry.getSession(sessionId);
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

  async reconcile(options: { resurrect?: boolean } = {}): Promise<ReconcileResult> {
    return reconcileSessions(this.deps, options);
  }

  /**
   * Archives a worker (issue #64): kills its tmux session — which ends the
   * pi process — and marks the worker `archived`, a terminal status. The
   * registry records (session + worker) are **kept** for history; archived
   * sessions are skipped by {@link reconcile} so a daemon restart never
   * resurrects a terminated worker.
   *
   * Idempotent and safe on already-dead panes: a missing tmux session is
   * not an error, and re-terminating an archived worker just refreshes the
   * archived status. Returns `null` for an unknown worker id.
   */
  async archiveWorker(workerId: string, message = "archived: terminated from the webapp"): Promise<Worker | null> {
    const worker = this.registry.getWorker(workerId);
    if (!worker) return null;
    const session = this.registry.getSession(worker.sessionId);
    if (session && (await this.tmux.hasSession(session.tmuxSession))) {
      // Issue #104: capture the pane's scrollback *before* killing the tmux
      // session — the bytes at termination — and persist it with the archived
      // record so the webapp can show a read-only log afterwards. A capture
      // failure must never block the terminate.
      try {
        const scrollback = await this.tmux.capturePane(session.tmuxSession, {
          lines: ARCHIVED_SCROLLBACK_LINES,
        });
        this.archivedLogs.save(worker.id, { capturedAt: new Date().toISOString(), scrollback });
      } catch (err) {
        console.error(`[sessions] scrollback capture failed for ${session.tmuxSession}:`, err);
      }
      await this.tmux.killSession(session.tmuxSession);
    }
    return this.registry.updateWorkerStatus(worker.id, "archived", message);
  }

  /** The worker's captured scrollback, if one was captured at terminate time (issue #104). */
  archivedScrollback(workerId: string): ArchivedScrollback | undefined {
    return this.archivedLogs.get(workerId);
  }

  /**
   * Relaunches a session's tmux pane (issue #117): the recovery path for a
   * pane the user exited (Ctrl+C, `exit`) or that otherwise died. Idempotent
   * weird-state cleanup — any lingering tmux session of the same name is
   * killed first — then the session's launch path re-runs:
   *
   * - orchestrator sessions are recreated in their recorded cwd (the
   *   project dir) with a plain interactive shell, the way
   *   {@link ensureOrchestrator} created them;
   * - worker sessions are re-spawned from their recorded cwd/command — the
   *   same #27 resurrection machinery reconcile() uses, but user-triggered.
   *
   * The registry records (session + worker) are kept as-is, so session
   * identity and history survive; a `stopped` worker goes back to
   * `running`. Terminal worker statuses are untouched (a `done` worker's
   * pipeline state must not regress because its pane was reloaded).
   *
   * Throws for unknown sessions and rejects archived worker sessions —
   * their history is the archived log view, not a relaunchable pane.
   */
  async relaunchSession(sessionId: string): Promise<Session> {
    const session = this.requireSession(sessionId);
    if (isArchivedWorkerSession(this.deps, session)) {
      throw new Error(`session ${sessionId} is archived: archived sessions cannot be relaunched`);
    }
    if (await this.tmux.hasSession(session.tmuxSession)) {
      await this.tmux.killSession(session.tmuxSession);
    }
    const { cwd, command } = launchPath(this.deps, session);
    await this.tmux.newSession(session.tmuxSession, { cwd, ...(command === undefined ? {} : { command }) });
    if (session.workerId !== null) {
      const worker = this.registry.getWorker(session.workerId);
      if (worker && worker.status === "stopped") {
        this.registry.updateWorkerStatus(worker.id, "running", "relaunched from the webapp");
      }
    }
    return this.registry.getSession(session.id) as Session;
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
      if (worker && !isTerminalWorkerStatus(worker.status)) {
        this.registry.updateWorkerStatus(worker.id, "stopped", "tmux session killed");
      }
    }
    this.registry.deleteSession(session.id);
    return session;
  }

  /** Deletes the captured scrollback of the given workers (issue #172 project teardown). */
  deleteArchivedLogs(workerIds: string[]): void { this.archivedLogs.deleteWorkers(workerIds); }

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
   * reloads: `pideck-<projectId>-<role>-<n>` with n starting at 1.
   */
  async nextTmuxSessionName(projectId: string, role: SessionRole): Promise<string> {
    const prefix = `pideck-${sanitizeTmuxSegment(projectId)}-${role}-`;
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
