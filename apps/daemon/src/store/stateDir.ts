import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { DEFAULT_STATE_DIR } from "@pideck/shared";

/** The daemon's state dir: `$PD_HOME` or `~/.pideck`. */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PD_HOME?.trim();
  return fromEnv ? resolve(fromEnv) : join(homedir(), DEFAULT_STATE_DIR);
}

/**
 * Everything the daemon owns inside the state dir, in one place. The install
 * layer owns the rest of `PD_HOME` (env, config, binaries, its own logs) —
 * see install/README.md for the split-ownership table.
 */
export function statePaths(stateDir: string) {
  return {
    sessionsFile: join(stateDir, "sessions.json"),
    projectsFile: join(stateDir, "projects.json"),
    settingsFile: join(stateDir, "settings.json"),
    promptsFile: join(stateDir, "prompts.json"),
    projectsDir: join(stateDir, "projects"),
    sessionsDir: join(stateDir, "sessions"),
    systemPromptsDir: join(stateDir, "system-prompts"),
    piSessionsDir: join(stateDir, "pi-sessions"),
    logsDir: join(stateDir, "logs"),
    tracesDir: join(stateDir, "traces"),
  };
}

export type StatePaths = ReturnType<typeof statePaths>;