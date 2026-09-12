import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProbeSchema, ProbeSchema, SessionSchema, type Session } from "@pideck/shared";
import { PromptOverrides } from "../prompts/overrides.js";
import { SessionRegistry } from "../sessions/registry.js";
import { Trace } from "../reconciler/trace.js";
import { FakeTmux } from "../sessions/testing/fakeTmux.js";
import { ReviewLoginFlow } from "./onboarding.js";
import { GlobalSettingsStore } from "../store/globalSettingsStore.js";
import { ProjectStore, type CommandRunner } from "../store/projectStore.js";
import type { DaemonDeps } from "./deps.js";
import { createUpdater } from "./update.js";

/**
 * CommandRunner fake for ProjectStore: `git clone` creates the target dir,
 * `git rev-parse` reports `main`, everything else succeeds with no output.
 */
export const fakeCommandRunner: CommandRunner = (cmd, args) => {
  if (cmd === "git" && args[0] === "clone") {
    const target = args[2];
    if (target !== undefined) mkdirSync(target, { recursive: true });
  }
  if (cmd === "git" && args[0] === "rev-parse") return { stdout: "main\n" };
  return { stdout: "" };
};

export function tempStateDir(prefix = "pideck-api-"): string {
  return join(tmpdir(), `${prefix}${Math.random().toString(36).slice(2)}`);
}

/**
 * Runner fake for the updater: `git rev-parse` reports a checkout SHA, `gh`
 * a different upstream SHA, `git remote` a repo URL — so a check reports an
 * update as available (the deps' buildSha matches the checkout, not the
 * upstream).
 */
const fakeUpdateRunner: CommandRunner = (cmd, args) => {
  if (cmd === "git" && args[0] === "rev-parse") return { stdout: "aaaaaaaaaaa\n" };
  if (cmd === "git" && args[0] === "remote") {
    return { stdout: "https://github.com/acme/widget.git\n" };
  }
  if (cmd === "gh") return { stdout: "bbbbbbbbbbb\n" };
  return { stdout: "" };
};

export function makeDeps(stateDir: string, tmux: FakeTmux): DaemonDeps & { updateSpawns: string[][] } {
  const registry = new SessionRegistry(stateDir);
  const settings = new GlobalSettingsStore(stateDir);
  const updateSpawns: string[][] = [];
  const deps: DaemonDeps = {
    version: "0.0.0-test",
    buildSha: "aaaaaaaaaaa",
    stateDir,
    pollIntervalSeconds: 30,
    projects: new ProjectStore(stateDir, fakeCommandRunner),
    settings,
    registry,
    tmux,
    prompts: new PromptOverrides(stateDir),
    trace: new Trace(stateDir),
    updates: createUpdater({
      srcDir: stateDir,
      registry,
      run: fakeUpdateRunner,
      spawn: (cmd, args) => {
        updateSpawns.push([cmd, ...args]);
      },
    }),
    ghPrimary: () =>
      Promise.resolve(ProbeSchema.parse({ ok: true, detail: "logged in as primary" })),
    ghReview: () =>
      Promise.resolve(ProbeSchema.parse({ ok: false, detail: "review account not configured" })),
    pi: () =>
      Promise.resolve(
        PiProbeSchema.parse({
          ok: true,
          detail: "pi configured: 1 providers, 2 models",
          providers: ["openrouter"],
          models: ["a/b", "c/d"],
          defaultModel: "a/b",
        }),
      ),
    reviewLogin: new ReviewLoginFlow(stateDir, settings),
  };
  return Object.assign(deps, { updateSpawns });
}

export function sessionRecord(overrides: Partial<Session> = {}): Session {
  return SessionSchema.parse({
    id: overrides.id ?? crypto.randomUUID(),
    persona: "worker",
    projectId: "proj",
    tmuxSession: `pideck-${overrides.id ?? crypto.randomUUID()}`,
    spawnedAt: new Date().toISOString(),
    model: null,
    ...overrides,
  });
}