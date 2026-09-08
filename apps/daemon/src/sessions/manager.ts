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
 * - startup reconciliation against live tmux state: re-discovery,
 *   resurrection of sessions lost to daemon restarts or reboots, and
 *   adoption of orphaned tmux sessions (issue #15)
 *
 * The orchestrator persona/prompt content itself is issue #12; we only
 * create and track its tmux session here.
 *
 * The command/name helpers this facade leans on (shQuote,
 * serialize/deserializeCommand, the resurrection guard, tmux-name
 * parse/sanitize) live in `tmux-commands.ts` and are re-exported here.
 */

import type { Session, Worker, WorkerKind, WorkerStatus } from "@agentskiss/shared";
import { ProjectLayout } from "./layout.js";
import type { SessionRegistry, SessionRole } from "./registry.js";
import { ArchivedLogStore, type ArchivedScrollback } from "./archived-logs.js";
import { Tmux } from "./tmux.js";
import {
  DEFAULT_WORKER_COMMAND,
  RESURRECT_WORKER_COMMAND,
  deserializeCommand,
  parseTmuxSessionName,
  resurrectionCommand,
  sanitizeTmuxSegment,
  serializeCommand,
} from "./tmux-commands.js";

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
  /** Working directory for the worker pane; defaults to the project's clone dir. */
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

/**
 * Worker statuses that are terminal: guard helpers must never overwrite them
 * (a `done` worker's pipeline state must not regress, an `archived` worker
 * stays in the archived log view). Shared by {@link SessionManager.reconcile}'s
 * {@link SessionManager.markWorkerStopped} and {@link SessionManager.killSession}
 * so the two guards cannot drift (issue #132).
 */
const TERMINAL_WORKER_STATUSES: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>([
  "done", "failed", "stopped", "archived",
]);

/** Result of {@link SessionManager.reconcile}. */
export interface ReconcileResult {
  /** Registry sessions whose tmux session is alive (re-attachable as-is). */
  alive: Session[];
  /** Registry sessions whose tmux session had died and was recreated. */
  resurrected: Session[];
  /** Registry sessions that could not be resurrected (workers marked stopped). */
  lost: Session[];
  /** Live tmux sessions adopted into the registry (no prior record). */
  adopted: Session[];
}

export class SessionManager {
  private readonly tmux: Tmux;
  private readonly registry: SessionRegistry;
  private readonly layout: ProjectLayout;
  private readonly archivedLogs: ArchivedLogStore;

  constructor(deps: {
    tmux: Tmux;
    registry: SessionRegistry;
    layout: ProjectLayout;
    /** Archived-scrollback store (issue #104); defaults to the state-dir file. */
    archivedLogs?: ArchivedLogStore;
  }) {
    this.tmux = deps.tmux;
    this.registry = deps.registry;
    this.layout = deps.layout;
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
    for (const existing of this.registry.listSessions({ projectId, role: "orchestrator" })) {
      if (await this.tmux.hasSession(existing.tmuxSession)) return existing;
    }
    await this.ensureProject(projectId);
    const name = await this.nextTmuxSessionName(projectId, "orchestrator");
    const cwd = this.layout.projectDir(projectId);
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
    const cwd = options.cwd ?? this.layout.cloneDir(projectId);
    const command = options.command ?? [...DEFAULT_WORKER_COMMAND];

    const session = this.registry.createSession({
      projectId,
      role: "worker",
      tmuxSession: name,
      // Record what is actually launched so reconcile() can resurrect the
      // same pane after a daemon restart or reboot (issue #27).
      cwd,
      command: serializeCommand(command),
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

    try {
      await this.tmux.newSession(name, { cwd, command });
    } catch (err) {
      this.registry.updateWorkerStatus(worker.id, "failed", `tmux launch failed: ${err instanceof Error ? err.message : String(err)}`);
      this.registry.deleteSession(session.id);
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

  /**
   * Reconciles the registry with live tmux state. Call once at daemon
   * startup (and optionally periodically) so sessions survive a daemon
   * restart or a machine reboot (issue #15):
   *
   * - registry sessions whose tmux session is still alive are kept as-is
   *   (already re-attachable from the web terminal);
   * - registry sessions whose tmux session died (daemon restart or reboot
   *   killed the tmux server) are **resurrected**: the tmux session is
   *   recreated in the session's recorded cwd and, for workers, re-running
   *   the recorded command guarded by {@link resurrectionCommand}; records
   *   without recorded cwd/command (e.g. written by older daemons) fall
   *   back to the role's default working directory and command;
   * - sessions that cannot be resurrected (e.g. their directory vanished)
   *   are reported as lost and any attached worker is marked `stopped`;
   * - live tmux sessions following our naming scheme with no registry
   *   record (e.g. the registry file was lost) are adopted.
   */
  async reconcile(options: { resurrect?: boolean } = {}): Promise<ReconcileResult> {
    const result: ReconcileResult = { alive: [], resurrected: [], lost: [], adopted: [] };
    const live = new Set(await this.tmux.listSessions());

    for (const session of this.registry.listSessions()) {
      // Issue #64: a terminated worker stays terminated — never resurrect
      // (or report lost) an archived worker session across restarts.
      if (this.isArchivedWorkerSession(session)) continue;
      if (live.has(session.tmuxSession)) {
        result.alive.push(session);
        continue;
      }
      if (options.resurrect === false) {
        this.markWorkerStopped(session, `tmux session ${session.tmuxSession} is gone`);
        result.lost.push(session);
        continue;
      }
      try {
        const { cwd, command } = this.launchPath(session);
        await this.tmux.newSession(session.tmuxSession, {
          cwd,
          ...(command === undefined ? {} : { command }),
        });
        result.resurrected.push(session);
      } catch (err) {
        this.markWorkerStopped(
          session,
          `tmux pane died and could not be recreated: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        result.lost.push(session);
      }
    }

    for (const name of live) {
      if (this.registry.getSessionByTmuxName(name) !== undefined) continue;
      const parsed = parseTmuxSessionName(name);
      if (!parsed) continue; // not a daemon-managed session; leave it alone
      result.adopted.push(
        this.registry.createSession({
          projectId: parsed.projectId,
          role: parsed.role,
          tmuxSession: name,
          workerId: null,
        }),
      );
    }
    return result;
  }

  /**
   * Resolves a session's launch path — the cwd and command used to
   * (re)create its tmux pane. Shared by {@link reconcile} (reboot recovery,
   * issue #27) and {@link relaunchSession} (user relaunch, issue #117) so
   * the two launch paths cannot drift (issue #132): workers re-run their
   * recorded command through the reboot-resilient guard
   * {@link resurrectionCommand} (binary on PATH → verbatim, else
   * interactive shell; legacy records without a recorded command keep the
   * role default); orchestrators get a plain interactive shell the way
   * {@link ensureOrchestrator} created them.
   */
  private launchPath(session: Session): { cwd: string; command?: string[] } {
    const cwd =
      session.cwd ??
      (session.role === "worker"
        ? this.layout.cloneDir(session.projectId)
        : this.layout.projectDir(session.projectId));
    const command =
      session.role === "worker"
        ? session.command !== undefined
          ? resurrectionCommand(deserializeCommand(session.command))
          : [...RESURRECT_WORKER_COMMAND]
        : undefined;
    return { cwd, ...(command === undefined ? {} : { command }) };
  }

  /** Marks a session's worker `stopped` (unless already terminal). */
  private markWorkerStopped(session: Session, message: string): void {
    if (session.workerId === null) return;
    const worker = this.registry.getWorker(session.workerId);
    if (!worker) return;
    if (TERMINAL_WORKER_STATUSES.has(worker.status)) {
      return;
    }
    this.registry.updateWorkerStatus(worker.id, "stopped", message);
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

  /** Whether the session is a worker session whose worker was archived (issue #64). */
  private isArchivedWorkerSession(session: Session): boolean {
    if (session.role !== "worker" || session.workerId === null) return false;
    return this.registry.getWorker(session.workerId)?.status === "archived";
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
    if (this.isArchivedWorkerSession(session)) {
      throw new Error(`session ${sessionId} is archived: archived sessions cannot be relaunched`);
    }
    if (await this.tmux.hasSession(session.tmuxSession)) {
      await this.tmux.killSession(session.tmuxSession);
    }
    const { cwd, command } = this.launchPath(session);
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
      if (worker && !TERMINAL_WORKER_STATUSES.has(worker.status)) {
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
