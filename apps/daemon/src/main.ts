/**
 * Daemon entrypoint: builds the stores, reconciles the session registry with
 * tmux at startup, and serves the REST API, the shared WebSocket and the
 * built web app. The reconciler loop runs alongside: every poll reads GitHub
 * and closes the gap between desired and actual state. Shutting down stops
 * the reconciler and closes the HTTP surface only — tmux panes and the
 * registry survive, and the next start reconciles them.
 */

import { createRequire } from "node:module";
import { DEFAULT_PORT } from "@pideck/shared";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PromptOverrides } from "./prompts/overrides.js";
import { ghPrimaryProbe, ghReviewProbe, piProbe } from "./api/probes.js";
import { serve, type DaemonServer } from "./api/server.js";
import type { DaemonDeps } from "./api/deps.js";
import { createUpdater } from "./api/update.js";
import { GhClient } from "./github/client.js";
import { reconcileWithTmux, defaultGitRunner } from "./sessions/spawn.js";
import { SessionRegistry } from "./sessions/registry.js";
import { Tmux } from "./sessions/tmux.js";
import { startReconciler } from "./reconciler/index.js";
import { Trace } from "./reconciler/trace.js";
import { GlobalSettingsStore } from "./store/globalSettingsStore.js";
import { ProjectStore } from "./store/projectStore.js";
import { resolveStateDir } from "./store/stateDir.js";

const require = createRequire(import.meta.url);

export interface StartOptions {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  webDistDir?: string | null;
}

export async function startDaemon(options: StartOptions = {}): Promise<DaemonServer> {
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  const projects = new ProjectStore(stateDir);
  const settings = new GlobalSettingsStore(stateDir);
  const registry = new SessionRegistry(stateDir);
  const prompts = new PromptOverrides(stateDir);
  // A private tmux socket keeps this daemon's panes off the default server,
  // so a second daemon (a test run next to a live install) never reaps the
  // other's panes as orphans.
  const tmux = new Tmux({ socketName: env.PD_TMUX_SOCKET?.trim() || undefined });
  const trace = new Trace(stateDir);

  const deps: DaemonDeps = {
    version: (require("../package.json") as { version: string }).version,
    stateDir,
    pollIntervalSeconds: pollIntervalSeconds(env),
    projects,
    settings,
    registry,
    tmux,
    prompts,
    trace,
    ghPrimary: () => ghPrimaryProbe(),
    ghReview: () => ghReviewProbe(settings.reviewToken()?.token ?? null),
    pi: async () => piProbe(),
    updates: createUpdater({
      srcDir: env.PD_SRC?.trim() || defaultSrcDir(),
      configJson: join(stateDir, "config.json"),
      registry,
    }),
  };

  // A restart is the first reconciliation: report sessions whose tmux pane
  // is gone or whose pi exited, and archive orphan panes with no record.
  // Records stay unarchived — the reconciler decides replacement.
  const { dead, orphanTmuxSessions } = await reconcileWithTmux(registry, tmux, {
    stateDir,
  });
  for (const session of dead) {
    console.log(`[daemon] session ${session.id} (${session.persona}) has no tmux pane`);
  }
  for (const orphan of orphanTmuxSessions) {
    console.log(`[daemon] archived orphan pane ${orphan} with no registry record`);
  }

  // The reconciler: every poll reads GitHub, derives desired state, and
  // closes the gap in the registry and tmux. A restart is just the first
  // poll, so the first tick runs as soon as the HTTP surface is up.
  const reconciler = startReconciler({
    gh: (repo) => new GhClient({ repo }),
    projects,
    settings,
    registry,
    tmux,
    prompts,
    stateDir,
    intervalMs: deps.pollIntervalSeconds * 1000,
    git: defaultGitRunner(),
    trace,
    notifyChange: () => deps.notifyChange?.(),
  });
  deps.reconcilerFacts = (projectId) => reconciler.factsFor(projectId);
  deps.githubStatus = () => reconciler.githubStatus();

  const daemon = await serve(deps, {
    host: env.PD_WEB_HOST ?? "0.0.0.0",
    port: env.PD_WEB_PORT === undefined ? DEFAULT_PORT : Number(env.PD_WEB_PORT),
    webDistDir: options.webDistDir === undefined ? defaultWebDistDir() : options.webDistDir,
  });
  void reconciler.tick();
  console.log(`[daemon] listening on http://${daemon.host}:${daemon.port}`);
  return {
    ...daemon,
    async close() {
      reconciler.stop();
      await daemon.close();
    },
  };
}

export async function main(): Promise<void> {
  const daemon = await startDaemon();
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void daemon.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function pollIntervalSeconds(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.PD_POLL_INTERVAL_SECONDS);
  return Number.isInteger(raw) && raw > 0 ? raw : 30;
}

/** The built web app sits next to the daemon package in the monorepo. */
function defaultWebDistDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
}

/** The monorepo root — the checkout a dev-run daemon updates from. */
function defaultSrcDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}