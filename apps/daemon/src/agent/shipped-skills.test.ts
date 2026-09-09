/**
 * Shipped-global skill launch args (issue #356): the `--skill <dir>` argv
 * pairs that keep PiDeck's shipped integration skills loadable on
 * `--no-skills` panes, plus the drift guard pinning the two shipped skill
 * tables (`SHIPPED_DEFAULT_SKILLS` — per-persona store seeds — and
 * `SHIPPED_GLOBAL_SKILLS` — ride-every-pane) to exactly partition the
 * shipped `agent/skills/` directories.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { SHIPPED_DEFAULT_SKILLS, SHIPPED_GLOBAL_SKILLS } from "@pideck/shared";

import { shippedGlobalSkillArgs } from "./shipped-skills.js";

/** The checkout's `agent/` dir (the shipped skill sources). */
const AGENT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "agent");

/** The shipped skill directories in the checkout, sorted. */
function shippedSkillDirs(): string[] {
  return readdirSync(path.join(AGENT_DIR, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Runs a test with PD_AGENT_DIR pinned to `dir` (restored afterwards — same pattern as prompt.test.ts). */
function withAgentDir<T>(dir: string, run: () => T): T {
  const saved = process.env["PD_AGENT_DIR"];
  process.env["PD_AGENT_DIR"] = dir;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env["PD_AGENT_DIR"];
    else process.env["PD_AGENT_DIR"] = saved;
  }
}

afterEach(() => {
  rmSync(path.join(os.tmpdir(), "pideck-shipped-skills-test"), { recursive: true, force: true });
});

describe("shipped-global skill args (issue #356)", () => {
  it("passes every shipped integration skill as an explicit --skill dir", () => {
    withAgentDir(AGENT_DIR, () => {
      expect(shippedGlobalSkillArgs()).toEqual(
        [...SHIPPED_GLOBAL_SKILLS].flatMap((name) => ["--skill", path.join(AGENT_DIR, "skills", name)]),
      );
    });
  });

  it("skips shipped integration skills whose directory is missing", () => {
    // A fixture agent dir with no skills: nothing resolves, so no args — a
    // missing shipped skill never breaks a launch.
    const empty = path.join(os.tmpdir(), "pideck-shipped-skills-test", "agent");
    mkdirSync(empty, { recursive: true });
    withAgentDir(empty, () => {
      expect(shippedGlobalSkillArgs()).toEqual([]);
    });
  });

  it("resolves only the shipped integration skills, not the store-seeded ones", () => {
    // The store-seeded shipped defaults (orchestrator defaults, issue #338)
    // must NOT ride every pane — only the global table does.
    const fixture = path.join(os.tmpdir(), "pideck-shipped-skills-test", "agent");
    mkdirSync(path.join(fixture, "skills", "bash-triage"), { recursive: true });
    mkdirSync(path.join(fixture, "skills", "using-pideck"), { recursive: true });
    writeFileSync(path.join(fixture, "skills", "bash-triage", "SKILL.md"), "---\nname: bash-triage\ndescription: x\n---\n");
    withAgentDir(fixture, () => {
      expect(shippedGlobalSkillArgs()).toEqual(["--skill", path.join(fixture, "skills", "using-pideck")]);
    });
  });
});

describe("shipped skill partition drift guard (issue #356)", () => {
  it("SHIPPED_DEFAULT_SKILLS ∪ SHIPPED_GLOBAL_SKILLS covers agent/skills exactly", () => {
    const assignable = SHIPPED_DEFAULT_SKILLS.map((skill) => skill.name);
    expect([...assignable, ...SHIPPED_GLOBAL_SKILLS].sort()).toEqual(shippedSkillDirs());
    // And the tables do not overlap: every shipped skill is exactly one of
    // per-persona assignable or global.
    expect(assignable.filter((name) => (SHIPPED_GLOBAL_SKILLS as readonly string[]).includes(name))).toEqual([]);
  });
});
