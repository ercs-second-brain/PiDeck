/**
 * @agentskiss/daemon — entry point.
 *
 * Wires the full daemon (issue #9): REST contract + CLI action routes,
 * websocket hub (`/api/ws`, kanban updates), the terminal bridge (`/ws`,
 * issue #7), static serving of the webapp build, and session
 * reconciliation against live tmux state at startup.
 *
 * Environment:
 * - `AGENTSKISS_HOME`     state dir (default `~/.agentskiss`)
 * - `AGENTSKISS_WEB_HOST` bind host (default `127.0.0.1`; units set `0.0.0.0`)
 * - `AGENTSKISS_WEB_PORT` bind port (default `8321`)
 * - `AGENTSKISS_WEB_DIST` webapp build dir (default: `<repo>/apps/web/dist`)
 * - `AGENTSKISS_WATCHER_ENABLED`           `0`/`false` disables the GitHub
 *                                          watcher/pipeline loop (issue #46)
 * - `AGENTSKISS_WATCHER_POLL_INTERVAL_MS`  watcher/PR-loop poll interval
 *                                          (default 30s; see the API rate
 *                                          budget note in pipeline/wiring.ts)
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDaemonContext } from "./api/context.js";
import { createDaemonServer } from "./api/server.js";
import { ensureProjectOrchestrators } from "./orchestrator/bootstrap.js";
import { TerminalBridge } from "./terminal/bridge.js";
import { attachTerminalWebSocket } from "./terminal/ws-server.js";

export function main(options: { stateDir?: string; host?: string; port?: number; webDist?: string | null } = {}): void {
  const host = options.host ?? process.env["AGENTSKISS_WEB_HOST"] ?? "127.0.0.1";
  const port = options.port ?? Number(process.env["AGENTSKISS_WEB_PORT"] ?? "8321");
  const webDist = options.webDist ?? undefined;

  const services = createDaemonContext({ stateDir: options.stateDir });
  const { server } = createDaemonServer({ services, webDist });

  // Terminal bridge (issue #7) on /ws: streams tmux panes to browser
  // terminals through the same tmux runner + session registry as the API.
  const bridge = new TerminalBridge({ tmux: services.tmux, registry: services.registry });
  const terminalWss = attachTerminalWebSocket(server, bridge);
  const closeTerminal = (): void => terminalWss.close();

  void services.sessions
    .reconcile()
    .then(
      (result) => {
        if (result.resurrected.length > 0 || result.lost.length > 0 || result.adopted.length > 0) {
          console.log(
            `[daemon] session reconcile: ${result.alive.length} alive, ${result.resurrected.length} resurrected, ${result.lost.length} lost, ${result.adopted.length} adopted`,
          );
        }
      },
      (err: unknown) => {
        console.error("[daemon] session reconcile failed:", err);
      },
    )
    // Orchestrator bootstrap (issue #12): after reconcile, ensure one
    // orchestrator session per registered project, listed in the web
    // terminal picker, running pi with the rendered orchestrator prompt.
    .then(() => ensureProjectOrchestrators(services))
    .catch((err: unknown) => {
      console.error("[daemon] orchestrator bootstrap failed:", err);
    })
    // GitHub automation (issue #46): after reconciliation + orchestrator
    // bootstrap, start the watchers and the issue/PR pipelines. start()
    // baselines the issue watchers so the existing backlog does not
    // mass-spawn on daemon (re)start, and sweeps issues created while the
    // daemon was down via the persisted per-project issue cursor (issue #50).
    .then(() => services.automation.start())
    .then(() => {
      if (services.automation.isRunning) {
        console.log(`[daemon] github watcher + pipelines started (${services.automation.watchedProjectIds.length} project(s) watched)`);
      } else {
        console.log("[daemon] github watcher + pipelines disabled (AGENTSKISS_WATCHER_ENABLED)");
      }
    })
    .catch((err: unknown) => {
      console.error("[daemon] github watcher/pipeline startup failed:", err);
    });

  server.listen(port, host, () => {
    console.log(`[daemon] agentskiss daemon listening on http://${host}:${port} (ws: /api/ws)`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[daemon] ${signal} received; shutting down`);
    // Shutdown ordering (issue #46): stop the github watcher + pipelines
    // first, so no new spawn/prompt work starts during teardown.
    services.automation.stop();
    services.hub.close();
    closeTerminal();
    server.close(() => process.exit(0));
    // Hard-exit fallback if sockets keep the handle open.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Run when executed as the main module (`node dist/index.js`, the installer's
// ExecStart target): dist/index.js → src/index.ts counterpart of this file.
const invokedAs = process.argv[1] !== undefined ? path.resolve(process.argv[1]) : undefined;
const thisFile = fileURLToPath(import.meta.url);
if (invokedAs !== undefined && (invokedAs === thisFile || invokedAs === thisFile.replace(/\.js$/, ".ts"))) {
  main();
}
