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

import { PERSONAS } from "@pideck/shared";
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
    store.saveSkill("tweak", { content: "---\nname: tweak\ndescription: Tweak\n---\n", personas: ["orchestrator", "worker"] });

    const expectedPrd = path.join(stateDir, "agent-assets", "skills", "prd.md");

    // Launch args: the seeded shipped skills ride along, in store order —
    // using-pideck (issue #463) ships applied to EVERY persona, the
    // methodology skills to the orchestrator.
    expect(store.skillLaunchArgs("orchestrator")).toContain("--skill");
    expect(store.skillLaunchArgs("orchestrator")).toEqual([
      "--skill", path.join(stateDir, "agent-assets", "skills", "using-pideck.md"),
      "--skill", path.join(stateDir, "agent-assets", "skills", "bash-triage.md"),
      "--skill", path.join(stateDir, "agent-assets", "skills", "concept-brief.md"),
      "--skill", expectedPrd,
      "--skill", path.join(stateDir, "agent-assets", "skills", "spec-to-issues.md"),
      "--skill", path.join(stateDir, "agent-assets", "skills", "tweak.md"),
    ]);
    expect(store.skillLaunchArgs("worker")).toEqual([
      "--skill", path.join(stateDir, "agent-assets", "skills", "using-pideck.md"),
      "--skill", path.join(stateDir, "agent-assets", "skills", "tweak.md"),
    ]);
    expect(store.skillLaunchArgs("researcher")).toEqual([
      "--skill", path.join(stateDir, "agent-assets", "skills", "using-pideck.md"),
    ]);

    // Unapplying (personas without the skill) drops the args but keeps the file
    // — only the every-persona using-pideck catalog remains.
    store.saveSkill("tweak", { content: "unchanged", personas: [] });
    expect(store.skillLaunchArgs("worker")).toEqual([
      "--skill", path.join(stateDir, "agent-assets", "skills", "using-pideck.md"),
    ]);
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

  it("rejects corrupt state files by falling back to shipped-default seeds", () => {
    stateDir = mkdtempSync(path.join(tmpdir(), "pideck-assets-"));
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "agent-assets.json"), "{not json");
    const store = new AgentAssetsStore(stateDir);
    expect(store.list().skills.map((skill) => skill.id)).toEqual(["using-pideck", "bash-triage", "concept-brief", "prd", "spec-to-issues"]);
    expect(store.promptOverride("orchestrator")).toBeUndefined();
  });

  it("migrates assets persisted with the pre-rename researcher persona id (issue #335)", () => {
    // A store file written before the researcher rename: the legacy persona
    // id is no longer in the enum, so without the load-time rewrite the
    // whole file would fail validation and the user's edits would vanish.
    stateDir = mkdtempSync(path.join(tmpdir(), "pideck-assets-"));
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "agent-assets.json"),
      JSON.stringify({
        version: 1,
        prompts: { investigator: { persona: "investigator", content: "legacy override", updatedAt: "2026-01-01T00:00:00.000Z" } },
        skills: [{ id: "prd", content: "prd skill", personas: ["investigator", "orchestrator"], updatedAt: "2026-01-01T00:00:00.000Z" }],
      }),
    );
    const store = new AgentAssetsStore(stateDir);

    expect(store.promptOverride("researcher")).toBe("legacy override");
    expect(store.list().skills[0]?.personas).toEqual(["researcher", "orchestrator"]);
    // Launch shaping works for the migrated persona (plus the every-persona
    // using-pideck catalog, issue #463).
    expect(store.skillLaunchArgs("researcher")).toEqual([
      "--skill", path.join(stateDir, "agent-assets", "skills", "prd.md"),
      "--skill", path.join(stateDir, "agent-assets", "skills", "using-pideck.md"),
    ]);

    // The rewrite persists: the next save drops the legacy id from the file.
    store.saveSkill("extra", { content: "x", personas: [] });
    expect(readFileSync(path.join(stateDir, "agent-assets.json"), "utf8")).not.toContain("investigator");
  });
});

describe("AgentAssetsStore: shipped-default skill seeding (issue #338, wired by #351 F2)", () => {
  it("starts with the shipped-default skills seeded and serves shipped prompt defaults", () => {
    const store = makeStore();
    const assets = store.list();
    expect(assets.prompts).toEqual([]);
    // The shipped-default skills, with the shipped SKILL.md content
    // deployed. using-pideck (issue #463, the CLI catalog) ships applied to
    // EVERY persona; the methodology skills to the orchestrator.
    expect(assets.skills.map((skill) => skill.id)).toEqual(["using-pideck", "bash-triage", "concept-brief", "prd", "spec-to-issues"]);
    for (const skill of assets.skills) {
      expect(skill.personas).toEqual(skill.id === "using-pideck" ? PERSONAS : ["orchestrator"]);
      expect(readFileSync(path.join(stateDir, "agent-assets", "skills", `${skill.id}.md`), "utf8")).toBe(skill.content);
    }
    expect(assets.skills[0]?.content).toContain("name: using-pideck"); // shipped SKILL.md content
    // The daemon ships a default for every persona — resolved from the repo.
    for (const persona of Object.keys(assets.defaults)) {
      expect(assets.defaults[persona as keyof typeof assets.defaults].length).toBeGreaterThan(0);
    }
    expect(assets.defaults["orchestrator"]).toContain("{{PROJECT_ID}}");
  });

  it("seeds user-deletions stick — a deleted shipped skill is never re-seeded (issue #463)", () => {
    const store = makeStore();
    expect(store.deleteSkill("prd")).toBe(true);
    expect(store.deleteSkill("using-pideck")).toBe(true);
    // A fresh store over the same state dir re-seeds nothing — the
    // deletions are recorded and survive the schema bump.
    const reloaded = new AgentAssetsStore(stateDir);
    expect(reloaded.list().skills.map((skill) => skill.id)).toEqual(["bash-triage", "concept-brief", "spec-to-issues"]);
  });

  it("version-2 state dirs gain newly shipped entries on load (issue #463 migration)", () => {
    // A pre-#463 store (version 2, no using-pideck): loading seeds the
    // restored entry applied to every persona without touching user rows.
    stateDir = mkdtempSync(path.join(tmpdir(), "pideck-assets-"));
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "agent-assets.json"),
      JSON.stringify({
        version: 2,
        prompts: {},
        skills: [{ id: "bash-triage", content: "user-edited triage", personas: ["orchestrator"], updatedAt: "2026-01-01T00:00:00.000Z" }],
      }),
    );
    const store = new AgentAssetsStore(stateDir);
    const ids = store.list().skills.map((skill) => skill.id);
    // The restored entry is seeded (applied to every persona); the user's
    // own row is untouched, and the bump is one-way (a delete after this
    // point sticks via the recorded deletions).
    expect(ids).toEqual(["bash-triage", "using-pideck", "concept-brief", "prd", "spec-to-issues"]);
    expect(store.getSkill("bash-triage")?.content).toBe("user-edited triage");
    expect(store.getSkill("using-pideck")?.personas).toEqual(PERSONAS);
    expect(JSON.parse(readFileSync(path.join(stateDir, "agent-assets.json"), "utf8")).version).toBe(3);
  });

  it("seeding is a no-op once the current schema version is reached", () => {
    const store = makeStore();
    expect(store.deleteSkill("using-pideck")).toBe(true); // recorded
    const reloaded = new AgentAssetsStore(stateDir);
    expect(reloaded.list().skills.map((skill) => skill.id)).not.toContain("using-pideck");
  });

  it("seeds only the missing shipped ids over a pre-seeding (version 1) state file", () => {
    stateDir = mkdtempSync(path.join(tmpdir(), "pideck-assets-"));
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "agent-assets.json"),
      JSON.stringify({
        version: 1,
        prompts: {},
        skills: [{ id: "prd", content: "user's prd skill", personas: ["worker"], updatedAt: "2026-01-01T00:00:00.000Z" }],
      }),
    );
    const store = new AgentAssetsStore(stateDir);
    const skills = store.list().skills;
    expect(skills.map((skill) => skill.id)).toEqual(["prd", "using-pideck", "bash-triage", "concept-brief", "spec-to-issues"]);
    // The user's own entry is untouched.
    expect(skills[0]).toMatchObject({ content: "user's prd skill", personas: ["worker"] });
  });
});
