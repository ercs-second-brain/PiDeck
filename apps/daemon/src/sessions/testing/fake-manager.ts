/**
 * Shared SessionManager test fixture (issue #394 F3): one FakeTmuxRunner,
 * one FakeGitRunner, and a SessionRegistry + ProjectLayout over a fresh tmp
 * dir, all wired into a SessionManager. Tests destructure only what their
 * assertions need — the makeManager copy-paste across the manager test
 * files differed only in the tmpdir prefix.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectLayout } from "../layout.js";
import { SessionManager } from "../manager.js";
import { SessionRegistry } from "../registry.js";
import { Tmux } from "../tmux.js";
import { FakeGitRunner } from "./fake-git.js";
import { FakeTmuxRunner } from "./fake-tmux.js";

export interface FakeSessionManager {
  manager: SessionManager;
  fake: FakeTmuxRunner;
  git: FakeGitRunner;
  registry: SessionRegistry;
  layout: ProjectLayout;
  /** The fresh tmp state dir backing the layout/registry (mkdtemp'd). */
  stateDir: string;
}

/** Builds a hermetic SessionManager over a fresh tmp state dir. */
export function makeSessionManager({ tmpPrefix }: { tmpPrefix: string }): FakeSessionManager {
  const stateDir = mkdtempSync(path.join(tmpdir(), tmpPrefix));
  const fake = new FakeTmuxRunner();
  const git = new FakeGitRunner();
  const tmux = new Tmux({ runner: (args) => fake.run(args) });
  const layout = new ProjectLayout(stateDir);
  const registry = new SessionRegistry(layout.sessionsFilePath());
  const manager = new SessionManager({ tmux, registry, layout, git: git.asRunner() });
  return { manager, fake, git, registry, layout, stateDir };
}
