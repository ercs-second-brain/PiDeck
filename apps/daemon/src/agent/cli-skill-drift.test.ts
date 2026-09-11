/**
 * using-pideck CLI-surface drift guard (issue #474).
 *
 * The `using-pideck` skill is the single source of truth for agent-facing
 * CLI usage (persona prompts point at it per issue #469), so its content
 * must track the CLI's actual surface — the same content-vs-reality
 * discipline as {@link ../agent/shipped-skills.test.ts}. Both directions
 * derive from code, never from a hand-maintained doc list:
 *
 * - the command list comes from the CLI's dispatch registry
 *   (`commands`, exported from `cli/main.ts`) — a new command fails here
 *   until SKILL.md documents it;
 * - the invocation forms come from the CLI's own usage text (`USAGE`,
 *   the `pideck` help) — each `pideck ...` usage line must appear
 *   verbatim in the skill corpus, so new flags/forms fail here too;
 * - the agent-kind list comes from `SHIPPED_AGENT_KINDS` (the built-ins
 *   ARE spec data, packages/shared/src/agent-kind-spec.ts) — each shipped
 *   kind must be documented in the skill;
 * - stale rows fail the other way: any command named in SKILL.md's
 *   catalog table must exist in the registry (a rename breaks docs
 *   loudly, not silently).
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SHIPPED_AGENT_KINDS } from "@pideck/shared";

import { USAGE, commands } from "../cli/main.js";

/** The checkout's `agent/` dir (the shipped skill sources). */
const AGENT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "agent");

/** The using-pideck skill dir in the checkout. */
const SKILL_DIR = path.join(AGENT_DIR, "skills", "using-pideck");

/** One page of the skill corpus: SKILL.md plus every commands/ page. */
interface SkillPage {
  /** Path relative to the skill dir (for failure messages). */
  file: string;
  /** Whitespace-flattened content (markdown wrapping must not matter). */
  text: string;
}

/** The whole skill corpus: SKILL.md plus every commands/ page. */
function skillCorpus(): SkillPage[] {
  const pages: SkillPage[] = [
    { file: "SKILL.md", text: flatten(readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8")) },
  ];
  for (const entry of readdirSync(path.join(SKILL_DIR, "commands"), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = path.join("commands", entry.name);
    pages.push({ file, text: flatten(readFileSync(path.join(SKILL_DIR, file), "utf8")) });
  }
  return pages;
}

/** Collapses whitespace so verbatim usage-line matching ignores wrapping. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The CLI's own `pideck ...` invocation lines (its agent-facing surface).
 * Command words are lowercase letters — this skips the USAGE title line
 * (`pideck — talk to the PiDeck daemon`). */
function cliUsageLines(): string[] {
  return USAGE.split("\n")
    .map((line) => flatten(line.trim()))
    .filter((line) => /^pideck [a-z]/.test(line));
}

describe("using-pideck CLI-surface drift guard (issue #474)", () => {
  it("SKILL.md documents every command in the CLI's dispatch registry", () => {
    const skill = flatten(readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8"));
    for (const command of Object.keys(commands)) {
      expect(skill.includes(`pideck ${command}`), `SKILL.md must document \`pideck ${command}\``).toBe(true);
    }
  });

  it("the skill corpus carries every usage line from the CLI's own help", () => {
    const corpus = skillCorpus();
    const missing: string[] = [];
    for (const usage of cliUsageLines()) {
      const covered = corpus.some((page) => page.text.includes(usage));
      if (!covered) missing.push(usage);
    }
    expect(
      missing,
      `usage lines not documented in the using-pideck skill (add them to the matching commands/ page):\n${missing.map((line) => `  ${line}`).join("\n")}`,
    ).toEqual([]);
  });

  it("the skill documents every shipped agent kind", () => {
    const corpus = skillCorpus();
    for (const kind of SHIPPED_AGENT_KINDS) {
      const covered = corpus.some((page) => page.text.includes(`--kind ${kind.name}`));
      expect(covered, `the using-pideck skill must document \`--kind ${kind.name}\` (agent-kind spawn page)`).toBe(true);
    }
  });

  it("SKILL.md's command table lists no stale commands", () => {
    // Table rows only (`| \`pideck <cmd>\` |`) — prose command mentions
    // legitimately appear in examples and cross-references.
    const table = readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8")
      .split("\n")
      .filter((line) => /^\|\s*`pideck [a-z-]+`/.test(line.trim()))
      .map((line) => /^\|\s*`pideck ([a-z-]+)`/.exec(line.trim())?.[1]);
    expect(table.length).toBeGreaterThan(0);
    for (const command of table) {
      expect(
        command !== undefined && command in commands,
        `SKILL.md's catalog lists \`pideck ${command ?? "?"}\`, which is not a CLI command — update the row`,
      ).toBe(true);
    }
  });
});