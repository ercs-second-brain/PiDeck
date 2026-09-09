/**
 * Shipped-global skill launch args (issue #356 — per-persona skill
 * enforcement at launch time).
 *
 * PiDeck-launched pi panes run with `--no-skills`: pi's global skill
 * discovery (the installer symlinks every shipped `agent/skills/<name>/`
 * into `~/.pi/agent/skills/`, which pi auto-loads in EVERY session) must
 * not leak skills restricted to other personas into a spawned pane — the
 * agent-assets store's per-persona assignment is the single source of
 * truth for store skills. Explicit `--skill <path>` args still load under
 * `--no-skills`, so the panes receive exactly:
 *
 * 1. the store skills assigned to their persona (launch paths pass those
 *    via {@link PersonaLaunchAssets.skillLaunchArgs}); and
 * 2. the shipped integration skills ({@link SHIPPED_GLOBAL_SKILLS}) —
 *    PiDeck's own CLI/plumbing documentation, unconditionally available on
 *    every pane because it describes how any PiDeck agent talks to the
 *    daemon (not a persona-specific capability).
 *
 * Consumers of {@link shippedGlobalSkillArgs}: the bootstrap's
 * orchestrator/global-agent/agent-kind launch lines and the session
 * manager's default worker command.
 */

import { existsSync } from "node:fs";

import { SHIPPED_GLOBAL_SKILLS } from "@pideck/shared";

import { findAgentPath } from "../orchestrator/prompt.js";

/**
 * `["--skill", dir, ...]` for every shipped integration skill whose
 * `agent/skills/<name>/` directory resolves — the explicit argv pairs that
 * keep PiDeck's own skills loadable on `--no-skills` panes. Names whose
 * directory cannot be resolved (e.g. a stripped install without `agent/`)
 * are skipped: a missing shipped skill must never break a launch.
 *
 * `agentDir` pins the `agent/` source dir for tests via `PD_AGENT_DIR`
 * (see {@link findAgentPath} — same resolution as every shipped-asset
 * lookup), so tests can point at a fixture tree.
 */
export function shippedGlobalSkillArgs(): string[] {
  const args: string[] = [];
  for (const name of SHIPPED_GLOBAL_SKILLS) {
    const dir = findAgentPath(undefined, "skills", name);
    if (existsSync(dir)) args.push("--skill", dir);
  }
  return args;
}
