/**
 * Shipped-skill drift guard (issue #439): `SHIPPED_DEFAULT_SKILLS` — the
 * per-persona store seeds (issue #338) — must exactly cover the shipped
 * `agent/skills/` directories.
 *
 * PiDeck no longer ships "integration" skills for anything the `pideck`
 * CLI or `gh` does deterministically (issue #439): the CLI commands stay
 * as tooling (`--help` is the docs) and the deterministic PR claiming
 * lives in daemon code (`pipeline/issue-refs.ts`). What ships is exactly
 * the orchestrator-default methodology skills, which ride the per-persona
 * assignment model — so every skill loadable by a pane appears in the
 * Prompts & Skills settings (B7 parity).
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SHIPPED_DEFAULT_SKILLS } from "@pideck/shared";

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

  it("ships only per-persona assignable skills — no ride-every-pane globals", () => {
    // Regression guard for issue #439: the shipped `SHIPPED_GLOBAL_SKILLS`
    // table (using-pideck, create-issue, spawn-worker, report-pr, ci-status,
    // review-comments, review-pr) is gone — every shipped skill is an
    // ordinary per-persona store seed, so no pane can load a skill absent
    // from the Prompts & Skills settings.
    expect(shippedSkillDirs()).toEqual(["bash-triage", "concept-brief", "prd", "spec-to-issues"]);
  });
});
