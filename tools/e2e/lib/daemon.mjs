import { spawn } from "node:child_process";
import { appendFileSync, openSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";

/**
 * The throwaway daemon: one `node dist/index.js` child with PD_HOME in the
 * e2e workspace and a free loopback port, stdout/stderr appended to the
 * workspace daemon.log. Waiting on /api/status is the readiness check. A
 * restart is the same start against the untouched state dir — the registry
 * and tmux panes survive the kill by design.
 */

export function start(root, ws, port, logPath, pollSeconds, tmuxSocket) {
  const out = openSync(logPath, "a");
  // The review token rides to the daemon over the loopback PUT only; the
  // runner's env var must never reach the daemon child, or every pane it
  // spawns inherits it (a worker's `env` would print the token).
  const runnerEnv = { ...process.env };
  delete runnerEnv.PD_E2E_REVIEW_TOKEN;
  const child = spawn(process.execPath, [join(root, "apps/daemon/dist/index.js")], {
    env: {
      ...runnerEnv,
      PD_HOME: ws.state,
      PD_WEB_HOST: "127.0.0.1",
      PD_WEB_PORT: String(port),
      PD_POLL_INTERVAL_SECONDS: String(pollSeconds),
      // A private tmux server: the throwaway daemon's orphan reaper must
      // never see (or be seen by) another daemon's pideck-* panes.
      PD_TMUX_SOCKET: `pideck-e2e-${tmuxSocket}`,
    },
    stdio: ["ignore", out, out],
  });
  return {
    child,
    port,
    async kill(signal = "SIGTERM") {
      if (child.exitCode !== null) return child.exitCode;
      child.kill(signal);
      for (let i = 0; child.exitCode === null && i < 100; i++) await sleep(100);
      if (child.exitCode === null) child.kill("SIGKILL");
      return child.exitCode;
    },
  };
}

/** Waits for /api/status with both legs ready — gh primary and pi. */
export async function waitReady(api, budgetMs = 180_000) {
  const startedAt = Date.now();
  let last = null;
  for (;;) {
    try {
      last = await api.status();
      if (last.ghReady && last.piReady) return last;
    } catch {
      // not listening yet
    }
    if (Date.now() - startedAt > budgetMs) {
      throw new Error(`daemon not ready within ${Math.round(budgetMs / 1000)}s: ${JSON.stringify(last)}`);
    }
    await sleep(1_000);
  }
}

export function logLine(logPath, line) {
  appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
}
