/**
 * AgentAssetsStore tests (issue #315): CRUD over the persisted
 * `agent-assets.json`, deployment of skill/override files under the state
 * dir, launch-argv shaping for the launch paths, and shipped-default
 * resolution (the real `agent/prompts/*.md` found by the repo walk-up).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentAssetsStore } from "./agent-assets.js";

let stateDir: string;

afterEach(() => {
  if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true });
});

function makeStore(): AgentAssetsStore {
  stateDir = mkdtempSync(path.join(tmpdir(), "pideck-assets-"));
  return new AgentAssetsStore(stateDir);
}

describe("AgentAssetsStore (issue #315)", () => {
  it("starts empty and serves shipped prompt defaults", () => {
    const store = makeStore();
    const assets = store.list();
    expect(assets.prompts).toEqual([]);
    expect(assets.skills).toEqual([]);
    // The daemon ships a default for every persona — resolved from the repo.
    for (const persona of Object.keys(assets.defaults)) {
      expect(assets.defaults[persona as keyof typeof assets.defaults].length).toBeGreaterThan(0);
    }
    expect(assets.defaults["orchestrator"]).toContain("{{PROJECT_ID}}");
  });

  it("persists prompt overrides across reloads and deploys the file", () => {
    const store = makeStore();
    store.savePromptOverride("orchestrator", "You are {{PROJECT_ID}}'s custom orchestrator.");
    expect(store.promptOverride("orchestrator")).toContain("custom orchestrator");
    const deployed = path.join(stateDir, "agent-assets", "prompts", "orchestrator.md");
    expect(readFileSync(deployed, "utf8")).toContain("custom orchestrator");

    // A fresh store over the same state dir sees the same override.
    expect(new AgentAssetsStore(stateDir).promptOverride("orchestrator")).toContain("custom orchestrator");

    // Deleting removes both the stored override and the deployed file.
    expect(store.deletePromptOverride("orchestrator")).toBe(true);
    expect(store.promptOverride("orchestrator")).toBeUndefined();
    expect(existsSync(deployed)).toBe(false);
    expect(store.deletePromptOverride("orchestrator")).toBe(false);
  });

  it("upserts skills, deploys single files, and shapes persona launch args", () => {
    const store = makeStore();
    store.saveSkill("prd", { content: "---\nname: prd\ndescription: PRD skill\n---\n", personas: ["orchestrator"] });
    store.saveSkill("tweak", { content: "---\nname: tweak\ndescription: Tweak\n---\n", personas: ["orchestrator", "worker"] });

    const expectedPrd = path.join(stateDir, "agent-assets", "skills", "prd.md");
    expect(readFileSync(expectedPrd, "utf8")).toContain("PRD skill");

    // Launch args: only the applied personas' panes get the skill, in store order.
    expect(store.skillLaunchArgs("orchestrator")).toEqual([
      "--skill",
      expectedPrd,
      "--skill",
      path.join(stateDir, "agent-assets", "skills", "tweak.md"),
    ]);
    expect(store.skillLaunchArgs("worker")).toEqual(["--skill", path.join(stateDir, "agent-assets", "skills", "tweak.md")]);
    expect(store.skillLaunchArgs("investigator")).toEqual([]);

    // Unapplying (personas without the skill) drops the args but keeps the file.
    store.saveSkill("tweak", { content: "unchanged", personas: [] });
    expect(store.skillLaunchArgs("worker")).toEqual([]);
    expect(existsSync(path.join(stateDir, "agent-assets", "skills", "tweak.md"))).toBe(true);
  });

  it("deletes skills with their deployed files and survives unknown ids", () => {
    const store = makeStore();
    store.saveSkill("gone", { content: "x", personas: ["worker"] });
    expect(store.deleteSkill("gone")).toBe(true);
    expect(existsSync(path.join(stateDir, "agent-assets", "skills", "gone.md"))).toBe(false);
    expect(store.deleteSkill("gone")).toBe(false);
  });

  it("shapes the worker prompt-override system-prompt argv only when an override exists", () => {
    const store = makeStore();
    expect(store.promptLaunchArgs("worker")).toEqual([]);
    store.savePromptOverride("worker", "Custom worker conventions");
    const file = path.join(stateDir, "agent-assets", "prompts", "worker.md");
    expect(store.promptLaunchArgs("worker")).toEqual(["--append-system-prompt", file]);
    // Other personas keep no launch argv — their boot paths read the store.
    expect(store.promptLaunchArgs("orchestrator")).toEqual([]);
  });

  it("rejects corrupt state files by falling back to empty assets", () => {
    stateDir = mkdtempSync(path.join(tmpdir(), "pideck-assets-"));
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "agent-assets.json"), "{not json");
    const store = new AgentAssetsStore(stateDir);
    expect(store.list().skills).toEqual([]);
    expect(store.promptOverride("orchestrator")).toBeUndefined();
  });
});
