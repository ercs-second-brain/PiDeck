import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadShippedPrompt } from "./shipped.js";
import { PromptOverrides } from "./overrides.js";

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "pideck-state-"));
}

describe("PromptOverrides", () => {
  it("returns null when nothing is stored", () => {
    const overrides = new PromptOverrides(stateDir());
    expect(overrides.get("worker")).toBeNull();
  });

  it("set and get round-trip per persona", () => {
    const dir = stateDir();
    const overrides = new PromptOverrides(dir);
    overrides.set("worker", "custom worker prompt");
    overrides.set("reviewer", "custom reviewer prompt");
    expect(overrides.get("worker")).toBe("custom worker prompt");
    expect(overrides.get("reviewer")).toBe("custom reviewer prompt");
    expect(overrides.get("orchestrator")).toBeNull();
  });

  it("persists across instances", () => {
    const dir = stateDir();
    new PromptOverrides(dir).set("global", "edited global");
    expect(new PromptOverrides(dir).get("global")).toBe("edited global");
  });

  it("reset removes the override and leaves others alone", () => {
    const dir = stateDir();
    const overrides = new PromptOverrides(dir);
    overrides.set("worker", "edited");
    overrides.set("orchestrator", "edited too");
    overrides.reset("worker");
    expect(overrides.get("worker")).toBeNull();
    expect(overrides.get("orchestrator")).toBe("edited too");
  });
});

describe("effective prompt precedence", () => {
  it("uses the shipped prompt until an override exists, then the override", () => {
    const dir = stateDir();
    const overrides = new PromptOverrides(dir);
    const shipped = loadShippedPrompt("worker");

    expect(overrides.get("worker") ?? shipped).toBe(shipped);

    overrides.set("worker", "my edition");
    expect(overrides.get("worker") ?? shipped).toBe("my edition");

    overrides.reset("worker");
    expect(overrides.get("worker") ?? shipped).toBe(shipped);
  });
});