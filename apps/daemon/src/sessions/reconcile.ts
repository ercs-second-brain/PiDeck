/**
 * Startup reconciliation (issue #15): re-discovery of daemon-managed tmux
 * sessions, resurrection of sessions lost to daemon restarts or reboots,
 * and adoption of orphaned tmux sessions. Split from manager.ts (kiss
 * max-lines budget); the {@link SessionManager} facade delegates here.
 */

import type { Session, WorkerStatus } from "@pideck/shared";
import type { ProjectLayout } from "./layout.js";
import type { SessionRegistry } from "./registry.js";
import type { Tmux } from "./tmux.js";
import {
  RESURRECT_WORKER_COMMAND,
  deserializeCommand,
  parseTmuxSessionName,
  resurrectionCommand,
} from "./tmux-commands.js";

/** Worker statuses that are terminal: guard helpers must never overwrite them. */
const TERMINAL_WORKER_STATUSES: ReadonlySet<WorkerStatus> = new Set([
  "done", "failed", "stopped", "archived",
]);

/** Result of a reconciliation pass. */
export interface ReconcileResult {
  /** Registry sessions whose tmux session is alive (re-attachable as-is). */
  alive: Session[];
  /** Registry sessions whose tmux session had died and was recreated. */
  resurrected: Session[];
  /** Registry sessions whose tmux session died and could not be recreated. */
  lost: Session[];
  /** Live tmux sessions adopted into the registry (no prior record). */
  adopted: Session[];
}

/** The collaborators reconciliation works over (satisfied by SessionManager's deps). */
export interface ReconcileDeps {
  tmux: Tmux;
  registry: SessionRegistry;
  layout: ProjectLayout;
}

/**
 * Resolves a session's launch path — the cwd and command used to
 * (re)create its tmux pane. Shared by reconcile (reboot recovery, issue
 * #27) and SessionManager.relaunchSession (user relaunch, issue #117) so
 * the two launch paths cannot drift (issue #132): workers re-run their
 * recorded command through the reboot-resilient guard
 * {@link resurrectionCommand} (binary on PATH → verbatim, else interactive
 * shell; legacy records without a recorded command keep the role default);
 * orchestrators get a plain interactive shell.
 */
export function launchPath(deps: ReconcileDeps, session: Session): { cwd: string; command?: string[] } {
  const cwd = session.cwd ??
    (session.role === "worker" ? deps.layout.cloneDir(session.projectId) : deps.layout.projectDir(session.projectId));
  const command = session.role === "worker"
    ? session.command !== undefined ? resurrectionCommand(deserializeCommand(session.command)) : [...RESURRECT_WORKER_COMMAND]
    : undefined;
  return { cwd, ...(command === undefined ? {} : { command }) };
}

/** Whether a worker status is terminal (guards must never overwrite them). */
export function isTerminalWorkerStatus(status: WorkerStatus): boolean {
  return TERMINAL_WORKER_STATUSES.has(status);
}

/** Marks a session's worker `stopped` (unless already terminal). */
function markWorkerStopped(deps: ReconcileDeps, session: Session, message: string): void {
  if (session.workerId === null) return;
  const worker = deps.registry.getWorker(session.workerId);
  if (!worker) return;
  if (TERMINAL_WORKER_STATUSES.has(worker.status)) return;
  deps.registry.updateWorkerStatus(worker.id, "stopped", message);
}

/** Whether the session is a worker session whose worker was archived (issue #64). */
export function isArchivedWorkerSession(deps: ReconcileDeps, session: Session): boolean {
  if (session.role !== "worker" || session.workerId === null) return false;
  return deps.registry.getWorker(session.workerId)?.status === "archived";
}

/**
 * Reconciles the registry with live tmux state. Call once at daemon startup
 * (and optionally periodically) so sessions survive a daemon restart or a
 * machine reboot (issue #15):
 *
 * - registry sessions whose tmux session is still alive are kept as-is
 *   (already re-attachable from the web terminal);
 * - registry sessions whose tmux session died (daemon restart or reboot
 *   killed the tmux server) are **resurrected**: the tmux session is
 *   recreated in the session's recorded cwd and, for workers, re-running
 *   the recorded command guarded by {@link resurrectionCommand}; records
 *   without recorded cwd/command (e.g. written by older daemons) fall back
 *   to the role's default working directory and command;
 * - sessions that cannot be resurrected (e.g. their directory vanished)
 *   are reported as lost and any attached worker is marked `stopped`;
 * - live tmux sessions following our naming scheme with no registry record
 *   (e.g. the registry file was lost) are adopted.
 */
export async function reconcileSessions(deps: ReconcileDeps, options: { resurrect?: boolean } = {}): Promise<ReconcileResult> {
  const { tmux, registry } = deps;
  const result: ReconcileResult = { alive: [], resurrected: [], lost: [], adopted: [] };
  const live = new Set(await tmux.listSessions());

  for (const session of registry.listSessions()) {
    // Issue #64: a terminated worker stays terminated — never resurrect
    // (or report lost) an archived worker session across restarts.
    if (isArchivedWorkerSession(deps, session)) continue;
    if (live.has(session.tmuxSession)) {
      result.alive.push(session);
      continue;
    }
    if (options.resurrect === false) {
      markWorkerStopped(deps, session, `tmux session ${session.tmuxSession} is gone`);
      result.lost.push(session);
      continue;
    }
    try {
      const { cwd, command } = launchPath(deps, session);
      await tmux.newSession(session.tmuxSession, {
        cwd,
        ...(command === undefined ? {} : { command }),
      });
      result.resurrected.push(session);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      markWorkerStopped(deps, session, `tmux pane died and could not be recreated: ${reason}`);
      result.lost.push(session);
    }
  }

  for (const name of live) {
    if (registry.getSessionByTmuxName(name) !== undefined) continue;
    const parsed = parseTmuxSessionName(name);
    if (!parsed) continue; // not a daemon-managed session; leave it alone
    result.adopted.push(
      registry.createSession({
        projectId: parsed.projectId,
        role: parsed.role,
        tmuxSession: name,
        workerId: null,
      }),
    );
  }
  return result;
}
