/**
 * Shipped-skill drift guard (issue #439, updated by issue #463):
 * `SHIPPED_DEFAULT_SKILLS` — the per-persona store seeds (issue #338) —
 * must exactly cover the shipped `agent/skills/` directories.
 *
 * PiDeck ships no skills for anything the `pideck` CLI or `gh` does
 * deterministically (issue #439): the CLI commands stay as tooling
 * (`--help` is the docs) and the deterministic PR claiming lives in daemon
 * code (`pipeline/issue-refs.ts`). What ships is the per-persona
 * assignable set — the orchestrator-default methodology skills plus the
 * every-persona `pideck` CLI catalog (issue #463) — so every skill
 * loadable by a pane appears in the Prompts & Skills settings (B7 parity).
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PERSONAS, SHIPPED_DEFAULT_SKILLS } from "@pideck/shared";

/** The checkout's `agent/` dir (the shipped skill sources). */
const AGENT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "agent");

/** The shipped skill directories in the checkout, sorted. */
function shippedSkillDirs(): string[] {
  return readdirSync(path.join(AGENT_DIR, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe("shipped skill drift guard (issue #439)", () => {
  it("SHIPPED_DEFAULT_SKILLS covers agent/skills exactly", () => {
    expect(SHIPPED_DEFAULT_SKILLS.map((skill) => skill.name).sort()).toEqual(shippedSkillDirs());
  });

  it("ships the pideck CLI catalog applied to every persona (issue #463)", () => {
    const catalog = SHIPPED_DEFAULT_SKILLS.find((skill) => skill.name === "using-pideck");
    expect(catalog).toBeDefined();
    expect([...catalog!.defaultPersonas].sort()).toEqual([...PERSONAS].sort());
  });
});