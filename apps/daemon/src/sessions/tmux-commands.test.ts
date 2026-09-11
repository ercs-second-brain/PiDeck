/**
 * Unit tests for the tmux command helpers (issues #4/#15/#27 + the #460
 * upgrade reconciliation): the recorded-command resurrection guard drops
 * dangling `--skill` paths — sessions spawned before an upgrade recorded
 * launch commands naming shipped skills the checkout no longer ships (the
 * seven globals of #439), and re-running them verbatim made pi report
 * "[Skill conflicts] … skill path does not exist" on every pane reload.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { dropDanglingSkillArgs, resurrectionCommand } from "./tmux-commands.js";

/** Arbitrary stale skill names a pre-upgrade recorded command might carry —
 * generated, not a memorial list: the dangling-arg drop is generic over
 * whatever skills a checkout stopped shipping (issue #463). */
const STALE_SKILLS = Array.from({ length: 7 }, (_, i) => `no-longer-shipped-skill-${i + 1}`);

function recordedPreUpgrade(validSkillPath: string): string[] {
  return [
    "pi",
    "--no-skills",
    ...STALE_SKILLS.flatMap((name) => ["--skill", `/nonexistent/pideck/src/agent/skills/${name}`]),
    "--skill",
    validSkillPath,
    "--append-system-prompt",
    "/tmp/worker-prompt.md",
  ];
}

describe("dropDanglingSkillArgs (issue #460)", () => {
  it("drops the seven removed shipped skills' --skill pairs, keeps everything else", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pideck-skillargs-"));
    const valid = `${dir}/kept.md`;
    writeFileSync(valid, "---\nname: kept\n---\n");
    const argv = recordedPreUpgrade(valid);
    const filtered = dropDanglingSkillArgs(argv);
    for (const name of STALE_SKILLS) {
      expect(filtered).not.toContain(`/nonexistent/pideck/src/agent/skills/${name}`);
    }
    expect(filtered.filter((arg) => arg === "--skill")).toEqual(["--skill"]);
    expect(filtered).toContain(valid);
    expect(filtered).toContain("--no-skills");
    expect(filtered).toContain("--append-system-prompt");
  });

  it("keeps a valid --skill path untouched", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pideck-skillargs-"));
    const valid = `${dir}/kept.md`;
    writeFileSync(valid, "x");
    expect(dropDanglingSkillArgs(["pi", "--skill", valid])).toEqual(["pi", "--skill", valid]);
  });

  it("drops a dangling --skill=<path> form too", () => {
    expect(dropDanglingSkillArgs(["pi", "--skill=/gone/skill"])).toEqual(["pi"]);
  });

  it("keeps --skill when the path exists and drops it when it does not (flag-form)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pideck-skillargs-"));
    const valid = `${dir}/kept.md`;
    writeFileSync(valid, "x");
    expect(dropDanglingSkillArgs(["pi", "--skill", "/gone", "--skill", valid])).toEqual(["pi", "--skill", valid]);
  });

  it("leaves argv without --skill flags alone", () => {
    const argv = ["pi", "--no-skills", "--foo", "bar"];
    expect(dropDanglingSkillArgs(argv)).toEqual(argv);
  });
});

describe("resurrectionCommand drops dangling skill paths (issue #460)", () => {
  it("re-runs the recorded command without the removed skills' --skill pairs", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pideck-skillargs-"));
    const valid = `${dir}/kept.md`;
    writeFileSync(valid, "x");
    const guarded = resurrectionCommand(recordedPreUpgrade(valid));
    const inner = guarded[2] ?? "";
    for (const name of STALE_SKILLS) expect(inner).not.toContain(name);
    expect(inner).toContain("kept.md");
    // The guard still falls back to an interactive shell when pi is gone.
    expect(inner).toContain("exec");
  });
});
