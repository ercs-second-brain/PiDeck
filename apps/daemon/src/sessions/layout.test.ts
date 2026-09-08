import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultStateDir, ProjectLayout, sanitizeSegment } from "./layout.js";

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

  it("defaults the state dir to the home-relative pideck dir", () => {
    const prev = process.env["PD_HOME"];
    delete process.env["PD_HOME"];
    try {
      const layout = new ProjectLayout();
      expect(layout.root).toBe(path.join(homedir(), ".pideck"));
    } finally {
      if (prev !== undefined) process.env["PD_HOME"] = prev;
    }
  });

  it("ensureProject creates the clone and worktrees dirs", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "pideck-layout-"));
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

describe("defaultStateDir", () => {
  const prev = process.env["PD_HOME"];

  afterEach(() => {
    if (prev === undefined) delete process.env["PD_HOME"];
    else process.env["PD_HOME"] = prev;
  });

  it("honors PD_HOME (set by the service units)", () => {
    process.env["PD_HOME"] = "/tmp/pd-home";
    expect(defaultStateDir()).toBe("/tmp/pd-home");
    expect(new ProjectLayout().root).toBe("/tmp/pd-home");
  });

  it("falls through to the home dir when PD_HOME is empty", () => {
    process.env["PD_HOME"] = "";
    expect(defaultStateDir()).toBe(path.join(homedir(), ".pideck"));
  });
});
