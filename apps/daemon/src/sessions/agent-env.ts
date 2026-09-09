/**
 * Canonical runtime environment for daemon-created tmux sessions.
 *
 * Every agent pane (orchestrators, workers, relaunch/reconcile) must run
 * under the SAME runtime the daemon itself resolved — the derivation the
 * installer owns: the service wrapper sources `$PD_HOME/env` (which the
 * update path repoints at the refreshed private Node, issue #202/#224) and
 * starts the daemon with that `PD_NODE` and a PATH led by the private node
 * bin dir. This module reads that ALREADY-RESOLVED process environment — it
 * deliberately does not parse `$PD_HOME/env` itself, so there is exactly
 * one derivation (the install's) and the daemon injects what it runs on.
 *
 * The values are injected per-session by {@link Tmux.newSession} (see
 * `tmux.ts`): the session command is wrapped in a `sh -c` that exports
 * these values before exec'ing the payload (issue #253) — the ONE env
 * mechanism, so the pane resolves the canonical runtime no matter the
 * tmux version or how stale the server's global environment is. A pane
 * otherwise inherits the tmux SERVER's global environment — captured
 * when that server first started — so on a long-lived user tmux server
 * every new session would keep running pi under a stale PATH (e.g. the
 * pre-update system Node) even after the daemon restarted on the fresh
 * runtime. (Issue #256 removed the redundant `new-session -e`
 * belt-and-suspenders this wrapper made dead.)
 */

/**
 * The env entries to inject into a new tmux session: the daemon's own
 * `PATH` (private node bin dir first, per the service wrapper) and
 * `PD_NODE` (the canonical private node binary, when set). Missing/empty
 * entries are skipped — a daemon started outside the service wrapper
 * without `PD_NODE` injects nothing extra for it.
 */
export function agentSessionEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const injected: Record<string, string> = {};
  for (const key of ["PATH", "PD_NODE"] as const) {
    const value = env[key];
    if (value !== undefined && value.length > 0) injected[key] = value;
  }
  return injected;
}
