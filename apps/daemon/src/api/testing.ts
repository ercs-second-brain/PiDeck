import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProbeSchema, ProbeSchema, SessionSchema, type Session } from "@pideck/shared";
import { PromptOverrides } from "../prompts/overrides.js";
import { SessionRegistry } from "../sessions/registry.js";
import { Trace } from "../reconciler/trace.js";
import { Tmux } from "../sessions/tmux.js";
import { GlobalSettingsStore } from "../store/globalSettingsStore.js";
import { ProjectStore, type CommandRunner } from "../store/projectStore.js";
import type { DaemonDeps } from "./deps.js";
import { createUpdater } from "./update.js";

/**
 * A Tmux fake that subclasses the real class so it stays assignable to the
 * registry-facing Tmux type; every pane op is recorded or kept in memory.
 */
export class FakeTmux extends Tmux {
  sent: { session: string; text: string }[] = [];
  alive = new Set<string>();
  killed: string[] = [];

  constructor() {
    super({ runner: async () => ({ stdout: "", stderr: "" }), enterDelayMs: 0 });
  }

  override create(name: string): Promise<void> {
    this.alive.add(name);
    return Promise.resolve();
  }

  override isAlive(name: string): Promise<boolean> {
    return Promise.resolve(this.alive.has(name));
  }

  override listSessions(): Promise<string[]> {
    return Promise.resolve([...this.alive]);
  }

  override sendLine(session: string, text: string): Promise<void> {
    this.sent.push({ session, text });
    return Promise.resolve();
  }

  override kill(session: string): Promise<void> {
    this.killed.push(session);
    this.alive.delete(session);
    return Promise.resolve();
  }

  override capturePane(): Promise<string> {
    return Promise.resolve("pane scrollback");
  }
}

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
 * Runner fake for the updater: `git rev-parse` reports a local SHA, `gh` a
 * different upstream SHA, `git remote` a repo URL — so a check reports an
 * update as available.
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
  const updateSpawns: string[][] = [];
  const deps: DaemonDeps = {
    version: "0.0.0-test",
    stateDir,
    pollIntervalSeconds: 30,
    projects: new ProjectStore(stateDir, fakeCommandRunner),
    settings: new GlobalSettingsStore(stateDir),
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