import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectSchema } from "@pideck/shared";
import { ProjectStore, runCommand, type CommandRunner } from "./projectStore.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), "pideck-projects-"));
  return dir;
}

function initOrigin(branch = "main"): string {
  const stateDir = tempDir();
  const origin = join(stateDir, "gh", "acme", "widget");
  execFileSync("git", ["init", "-b", branch, origin]);
  writeFileSync(join(origin, "README.md"), "x\n");
  execFileSync("git", ["-C", origin, "add", "."]);
  execFileSync("git", ["-C", origin, "-c", "user.name=t", "-c", "user.email=t@example.com",
    "commit", "-m", "init"]);
  return origin;
}

describe("ProjectStore", () => {
  it("clones a repo and defaults settings to the shared contract", async () => {
    const origin = initOrigin();
    const stateDir = dirname(origin);
    const store = new ProjectStore(stateDir);

    const project = await store.add({ mode: "clone", repoUrl: origin });

    expect(project.owner).toBe("acme");
    expect(project.repo).toBe("widget");
    expect(project.name).toBe("widget");
    expect(project.defaultBranch).toBe("main");
    expect(project.path).toBe(join(stateDir, "projects", "acme-widget", "clone"));
    expect(existsSync(join(project.path, "README.md"))).toBe(true);
    expect(store.get("acme-widget")).toEqual(project);
    expect(store.settings("acme-widget")).toEqual({
      workerConcurrency: 3,
      maxFixAttempts: 5,
      contextLimitPercent: 80,
      stallMinutes: 20,
      autoMerge: false,
    });
  });

  it("detects a non-default branch name", async () => {
    const origin = initOrigin("trunk");
    const store = new ProjectStore(dirname(origin));
    expect((await store.add({ mode: "clone", repoUrl: origin })).defaultBranch).toBe("trunk");
  });

  it("honours an explicit project name on clone", async () => {
    const origin = initOrigin();
    const store = new ProjectStore(dirname(origin));
    const project = await store.add({ mode: "clone", repoUrl: origin, name: "My Widget" });
    expect(project.name).toBe("My Widget");
  });

  it("creates a repo via gh and clones it", async () => {
    const origin = initOrigin();
    const stateDir = dirname(origin);
    const run: CommandRunner = (cmd, args, cwd) =>
      cmd === "gh" ? { stdout: `file://${origin}\n` } : runCommand(cmd, args, cwd);
    const store = new ProjectStore(stateDir, run);

    const project = await store.add({ mode: "create", name: "fresh", private: true });

    expect(project.owner).toBe("acme");
    expect(project.repo).toBe("widget");
    expect(project.name).toBe("fresh");
    expect(existsSync(join(project.path, "README.md"))).toBe(true);
    expect(ProjectSchema.parse(project)).toEqual(project);
  });

  it("uniquifies ids on collision", async () => {
    const origin = initOrigin();
    const sibling = `${origin}-2`;
    execFileSync("git", ["clone", origin, sibling]);
    const store = new ProjectStore(dirname(origin));

    const first = await store.add({ mode: "clone", repoUrl: origin });
    const second = await store.add({ mode: "clone", repoUrl: sibling });

    expect(first.id).toBe("acme-widget");
    expect(second.id).toBe("acme-widget-2");
    expect(store.list().map((p) => p.id)).toEqual(["acme-widget", "acme-widget-2"]);
  });

  it("updates project settings and persists them", async () => {
    const origin = initOrigin();
    const stateDir = dirname(origin);
    const store = new ProjectStore(stateDir);
    await store.add({ mode: "clone", repoUrl: origin });

    store.updateSettings("acme-widget", { workerConcurrency: 2, autoMerge: true });

    const reopened = new ProjectStore(stateDir);
    expect(reopened.settings("acme-widget")).toEqual({
      workerConcurrency: 2,
      maxFixAttempts: 5,
      contextLimitPercent: 80,
      stallMinutes: 20,
      autoMerge: true,
    });
  });

  it("updates editable project fields and persists them", async () => {
    const origin = initOrigin();
    const stateDir = dirname(origin);
    const store = new ProjectStore(stateDir);
    const project = await store.add({ mode: "clone", repoUrl: origin });

    const updated = store.update(project.id, { name: "Widget 2", defaultBranch: "trunk" });

    expect(updated.name).toBe("Widget 2");
    expect(updated.defaultBranch).toBe("trunk");
    const reopened = new ProjectStore(stateDir);
    expect(reopened.get(project.id).name).toBe("Widget 2");
    expect(reopened.get(project.id).defaultBranch).toBe("trunk");
  });

  it("rejects an unknown project", async () => {
    const store = new ProjectStore(tempDir());
    expect(() => store.updateSettings("nope", { autoMerge: true })).toThrow(/unknown project/);
    expect(() => store.get("nope")).toThrow(/unknown project/);
    expect(() => store.settings("nope")).toThrow(/unknown project/);
    expect(() => store.remove("nope")).toThrow(/unknown project/);
  });

  it("remove deletes the clone directory and the record", async () => {
    const origin = initOrigin();
    const stateDir = dirname(origin);
    const store = new ProjectStore(stateDir);
    const project = await store.add({ mode: "clone", repoUrl: origin });

    store.remove(project.id);

    expect(existsSync(join(stateDir, "projects", project.id))).toBe(false);
    expect(store.list()).toEqual([]);
    expect(() => store.get(project.id)).toThrow(/unknown project/);
  });

  it("rejects a repo URL it cannot parse", async () => {
    const store = new ProjectStore(tempDir());
    await expect(store.add({ mode: "clone", repoUrl: "not-a-url" })).rejects.toThrow();
  });

  it("guarantees review-account access on registration", async () => {
    const origin = initOrigin();
    const checked: string[] = [];
    const store = new ProjectStore(dirname(origin), runCommand, async (repo) => {
      checked.push(`${repo.owner}/${repo.repo}`);
    });

    const project = await store.add({ mode: "clone", repoUrl: origin });

    expect(checked).toEqual(["acme/widget"]);
    expect(store.get(project.id)).toEqual(project);
  });

  it("registers the project even when the access check fails", async () => {
    const origin = initOrigin();
    const store = new ProjectStore(dirname(origin), runCommand, async () => {
      throw new Error("review account has no access to acme/widget");
    });

    const project = await store.add({ mode: "clone", repoUrl: origin });

    expect(store.get(project.id)).toEqual(project);
  });

  it("throws a clear error on a corrupt projects file", async () => {
    const stateDir = tempDir();
    writeFileSync(join(stateDir, "projects.json"), "{");
    expect(() => new ProjectStore(stateDir)).toThrow(/projects\.json/);
  });
});
