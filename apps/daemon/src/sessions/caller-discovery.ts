/**
 * Calling-pane discovery for agent-kind spawns (docs/agent-kinds.md §3,
 * issues #297/#300/#302).
 *
 * Agent kinds are callable from any role — global agent, project
 * orchestrator, worker, review agent — and the researcher's whole
 * contract is "the report returns to the calling session". The merged
 * `pideck spawn --kind` CLI carries no caller identity in its request
 * body, so the daemon resolves the caller from its environment: the CLI
 * process runs inside the caller's tmux pane and is **still alive** while
 * it awaits the daemon's HTTP response. Walking the process ancestry of
 * every live `spawn --kind` invocation up to a daemon-managed pane PID
 * therefore pinpoints the calling pane (and the registry session behind
 * it) — regardless of the caller's role.
 *
 * Best-effort by design: any failure (no /proc, the caller is outside a
 * daemon pane, ambiguous matches) resolves to `undefined` and the spawn
 * route falls back (audit kinds → the project orchestrator they report to;
 * caller-routed kinds → a precise rejection). Linux-only (`/proc`), which
 * is the daemon's own deployment target (systemd service units).
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** One live process: pid, parent pid, and argv. */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  cmdline: string[];
}

/** The collaborators caller discovery reads. Both default to the real machine. */
export interface CallerDiscoveryDeps {
  /** tmux session name → pane PID, for every pane on the server. */
  panePids: () => Promise<Map<string, number>>;
  /** Snapshot of the live process table. */
  processes: () => Promise<ProcessInfo[]>;
}

/** Ancestry-walk bound: a pane shell is a handful of levels up, never 100. */
const MAX_ANCESTRY_DEPTH = 32;

/**
 * Resolves the tmux session name of the pane a live `pideck spawn --kind`
 * invocation runs in, or `undefined` when it cannot be determined
 * (outside a daemon pane, ambiguous, or the platform exposes no process
 * table). Exactly one unambiguous calling pane wins; anything else is
 * `undefined` — a wrongly-attributed parent would misroute the report.
 */
export async function discoverCallerSession(deps: CallerDiscoveryDeps): Promise<string | undefined> {
  let panes: Map<string, number>;
  let procs: ProcessInfo[];
  try {
    [panes, procs] = await Promise.all([deps.panePids(), deps.processes()]);
  } catch {
    return undefined;
  }
  if (panes.size === 0) return undefined;

  const ppidByPid = new Map<number, number>();
  for (const proc of procs) ppidByPid.set(proc.pid, proc.ppid);

  // Candidates: live invocations of the agent-kind spawn CLI. The argv
  // markers (`spawn` + `--kind`) never appear on the daemon's own command
  // line, and requiring a `pideck` argv element keeps foreign processes out.
  const candidates = procs.filter(
    (proc) =>
      proc.cmdline.includes("spawn") &&
      proc.cmdline.includes("--kind") &&
      proc.cmdline.some((arg) => arg.includes("pideck")),
  );

  const panePidToSession = new Map<number, string>();
  for (const [session, pid] of panes) panePidToSession.set(pid, session);

  const hits = new Set<string>();
  for (const candidate of candidates) {
    let pid: number | undefined = candidate.pid;
    for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
      const session = pid !== undefined ? panePidToSession.get(pid) : undefined;
      if (session !== undefined) {
        hits.add(session);
        break;
      }
      pid = pid !== undefined ? ppidByPid.get(pid) : undefined;
      if (pid === undefined || pid <= 1) break;
    }
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}

/** Default `processes`: a `/proc` snapshot (Linux). Errors surface to the caller. */
export function procSnapshot(): ProcessInfo[] {
  const procs: ProcessInfo[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = readFileSync(path.join("/proc", entry, "stat"), "utf8");
      // comm may contain spaces/parens: fields resume after its closing paren.
      const close = stat.lastIndexOf(")");
      const after = stat.slice(close + 2).split(" ");
      const ppid = Number(after[1]);
      const cmdline = readFileSync(path.join("/proc", entry, "cmdline"), "utf8")
        .split("\0")
        .filter((arg) => arg.length > 0);
      if (Number.isFinite(ppid) && cmdline.length > 0) procs.push({ pid, ppid, cmdline });
    } catch {
      // The process vanished mid-scan; skip it.
    }
  }
  return procs;
}

/** Default `panePids`: every pane on the tmux server, via `list-panes -a`. */
export async function tmuxPanePids(tmux: { run(args: string[]): Promise<{ stdout: string }> }): Promise<Map<string, number>> {
  const { stdout } = await tmux.run(["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"]);
  const panes = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    const [name, pid] = line.split("\t");
    if (name === undefined || pid === undefined) continue;
    const parsed = Number(pid.trim());
    if (name.trim().length > 0 && Number.isFinite(parsed)) panes.set(name.trim(), parsed);
  }
  return panes;
}
