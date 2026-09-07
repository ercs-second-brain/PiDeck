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
 */

import type { Session, Worker, WorkerStatus } from "@agentskiss/shared";
import { ProjectLayout } from "./layout.js";
import type { SessionRegistry, SessionRole } from "./registry.js";
import { Tmux } from "./tmux.js";

/** Characters that are safe in a POSIX shell word without quoting. */
const SH_BARE_WORD = /^[A-Za-z0-9_./:=,+@%^-]+$/;

/** Single-quotes a word for the POSIX shell unless it is safe bare. */
export function shQuote(word: string): string {
  return SH_BARE_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Command launched in worker panes. The pi coding agent CLI runs interactively in the pane. */
export const DEFAULT_WORKER_COMMAND: string[] = ["pi"];

/**
 * Command used to resurrect a worker pane with no recorded command (see
 * {@link SessionManager.reconcile}): the {@link DEFAULT_WORKER_COMMAND}
 * guarded by {@link resurrectionCommand}.
 *
 * After a reboot/restart the agent binary may be missing; re-running the
 * agent verbatim would exit instantly and tmux would close the session,
 * making it un-attachable. Instead, run the agent when it is on PATH, else
 * fall back to an interactive shell so the pane survives and stays
 * re-attachable.
 */
export const RESURRECT_WORKER_COMMAND: string[] = resurrectionCommand(DEFAULT_WORKER_COMMAND);

/**
 * Serializes a pane command argv into the `Session.command` contract field: a
 * POSIX-shell word string (e.g. `pi` or `bash -c 'sleep 300'`) that
 * {@link deserializeCommand} can parse back (issue #27).
 */
export function serializeCommand(command: string[]): string {
  return command.map(shQuote).join(" ");
}

/**
 * Parses a `Session.command` string back into argv. Best-effort POSIX-ish
 * splitting — whitespace-separated words with single-quote, double-quote and
 * backslash escaping — that round-trips {@link serializeCommand} exactly.
 */
export function deserializeCommand(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of command.trim()) {
    if (escaped) {
      current += ch;
      started = true;
      escaped = false;
      continue;
    }
    if (quote === null && ch === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote === null && (ch === " " || ch === "\t")) {
      if (started) {
        argv.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started || current !== "") argv.push(current);
  return argv;
}

/**
 * Wraps a pane command in the reboot-resilient shell guard used by
 * {@link RESURRECT_WORKER_COMMAND}: run the recorded command verbatim when
 * its binary is on PATH, else fall back to an interactive shell so the pane
 * survives a reboot/restart where the agent binary may be missing (issue #15).
 * Used by {@link SessionManager.reconcile} to faithfully resurrect recorded
 * spawn commands (issue #27).
 */
export function resurrectionCommand(recorded: string[]): string[] {
  const bin = recorded[0] ?? "";
  return [
    "sh",
    "-c",
    `command -v ${shQuote(bin)} >/dev/null 2>&1 && exec ${recorded
      .map(shQuote)
      .join(" ")} || exec "\${SHELL:-/bin/sh}"`,
  ];
}

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

/** Matches tmux session names created by {@link SessionManager}: `agentskiss-<projectId>-<role>-<n>`. */
const TMUX_NAME_PATTERN = /^agentskiss-(.+)-(orchestrator|worker)-(\d+)$/;

/**
 * Parses a daemon-managed tmux session name back into its parts. Note the
 * projectId is the *sanitized* segment (see {@link sanitizeTmuxSegment}); the
 * mapping back to the raw project id is lossy by design.
 */
export function parseTmuxSessionName(name: string): {
  projectId: string;
  role: SessionRole;
  n: number;
} | null {
  const match = TMUX_NAME_PATTERN.exec(name);
  if (!match) return null;
  return { projectId: match[1] ?? "", role: match[2] as SessionRole, n: Number(match[3]) };
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
        const cwd =
          session.cwd ??
          (session.role === "worker"
            ? this.layout.cloneDir(session.projectId)
            : this.layout.projectDir(session.projectId));
        // Recorded commands are re-run through the reboot-resilient guard
        // (binary on PATH → verbatim, else interactive shell); legacy
        // records without a recorded command keep the role default.
        const command =
          session.command !== undefined
            ? resurrectionCommand(deserializeCommand(session.command))
            : session.role === "worker"
              ? [...RESURRECT_WORKER_COMMAND]
              : undefined;
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

  /** Marks a session's worker `stopped` (unless already terminal). */
  private markWorkerStopped(session: Session, message: string): void {
    if (session.workerId === null) return;
    const worker = this.registry.getWorker(session.workerId);
    if (!worker) return;
    if (worker.status === "done" || worker.status === "failed" || worker.status === "stopped") {
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
      await this.tmux.killSession(session.tmuxSession);
    }
    return this.registry.updateWorkerStatus(worker.id, "archived", message);
  }

  /** Whether the session is a worker session whose worker was archived (issue #64). */
  private isArchivedWorkerSession(session: Session): boolean {
    if (session.role !== "worker" || session.workerId === null) return false;
    return this.registry.getWorker(session.workerId)?.status === "archived";
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
      if (worker && worker.status !== "done" && worker.status !== "failed" && worker.status !== "archived") {
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
