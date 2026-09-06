import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectLayout, sanitizeSegment } from "./layout.js";

describe("sanitizeSegment", () => {
  it("keeps safe characters", () => {
    expect(sanitizeSegment("my-project_1")).toBe("my-project_1");
  });

  it("replaces tmux-unsafe characters (., :, spaces, slashes)", () => {
    expect(sanitizeSegment("a.b:c/d e")).toBe("a-b-c-d-e");
  });

  it("falls back to a placeholder for empty results", () => {
    expect(sanitizeSegment("...")).toBe("project");
  });
});

describe("ProjectLayout", () => {
  it("computes per-project paths under the state dir", () => {
    const layout = new ProjectLayout("/state");
    expect(layout.root).toBe("/state");
    expect(layout.projectsRoot()).toBe("/state/projects");
    expect(layout.projectDir("proj")).toBe("/state/projects/proj");
    expect(layout.cloneDir("proj")).toBe("/state/projects/proj/clone");
    expect(layout.worktreesDir("proj")).toBe("/state/projects/proj/worktrees");
    expect(layout.worktreeDir("proj", "issue-4")).toBe("/state/projects/proj/worktrees/issue-4");
    expect(layout.sessionsFilePath()).toBe("/state/sessions.json");
  });

  it("defaults the state dir to ~/.agentskiss", () => {
    const layout = new ProjectLayout();
    expect(layout.root).toBe(path.join(homedir(), ".agentskiss"));
  });

  it("ensureProject creates the clone and worktrees dirs", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "agentskiss-layout-"));
    const layout = new ProjectLayout(stateDir);
    const dirs = layout.ensureProject("proj");
    expect(existsSync(dirs.cloneDir)).toBe(true);
    expect(existsSync(dirs.worktreesDir)).toBe(true);
    // Idempotent.
    expect(layout.ensureProject("proj")).toEqual(dirs);
  });

  it("sanitizes project ids in paths", () => {
    const layout = new ProjectLayout("/state");
    expect(layout.projectDir("my.project")).toBe("/state/projects/my-project");
  });
});
