import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Personas } from "@pideck/shared";
import { agentDir, loadShippedPrompt } from "./shipped.js";

const previousAgentDir = process.env.PD_AGENT_DIR;

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PD_AGENT_DIR;
  else process.env.PD_AGENT_DIR = previousAgentDir;
});

describe("loadShippedPrompt", () => {
  it("loads a non-empty prompt for every persona", () => {
    for (const persona of Personas) {
      expect(loadShippedPrompt(persona).length).toBeGreaterThan(0);
    }
  });

  it("resolves the worker prompt with its placeholders", () => {
    const worker = loadShippedPrompt("worker");
    expect(worker).toContain("# Worker");
    expect(worker).toContain("{{ISSUE_NUMBER}}");
    expect(worker).toContain("{{DEFAULT_BRANCH}}");
  });

  it("honours PD_AGENT_DIR over the walked-up agent directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "pideck-agent-"));
    const promptsDir = join(dir, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(join(promptsDir, "worker.md"), "# Custom worker");
    process.env.PD_AGENT_DIR = dir;
    expect(agentDir()).toBe(dir);
    expect(loadShippedPrompt("worker")).toBe("# Custom worker");
    rmSync(dir, { recursive: true, force: true });
  });
});