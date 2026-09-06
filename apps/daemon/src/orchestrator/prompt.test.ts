/**
 * Orchestrator prompt rendering tests (issue #12): placeholder
 * substitution, project value wiring, and prompt source discovery.
 */

import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Project } from "@agentskiss/shared";

import { findAgentPromptPath, orchestratorPromptValues, renderOrchestratorPrompt, renderTemplate } from "./prompt.js";

function fakeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "o-r",
    name: "My Project",
    repoUrl: "https://github.com/o/r",
    defaultBranch: "main",
    settings: { autoAgentUsername: null, workerConcurrency: 1 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("renderTemplate", () => {
  it("substitutes {{PLACEHOLDER}} tokens", () => {
    expect(renderTemplate("hello {{PROJECT_ID}} of {{PROJECT_NAME}}!", { PROJECT_ID: "o-r", PROJECT_NAME: "R" })).toBe(
      "hello o-r of R!",
    );
  });

  it("repeats a placeholder for every occurrence", () => {
    expect(renderTemplate("{{PROJECT_ID}}/{{PROJECT_ID}}", { PROJECT_ID: "p" })).toBe("p/p");
  });

  it("leaves unknown placeholders verbatim", () => {
    expect(renderTemplate("keep {{UNKNOWN_TOKEN}}", { PROJECT_ID: "p" })).toBe("keep {{UNKNOWN_TOKEN}}");
  });
});

describe("orchestratorPromptValues", () => {
  it("maps the documented placeholders to project fields", () => {
    const values = orchestratorPromptValues(fakeProject(), "/state/projects/o-r/clone");
    expect(values).toEqual({
      PROJECT_ID: "o-r",
      PROJECT_NAME: "My Project",
      PROJECT_REPO_URL: "https://github.com/o/r",
      PROJECT_DEFAULT_BRANCH: "main",
      PROJECT_PATH: "/state/projects/o-r/clone",
    });
  });
});

describe("renderOrchestratorPrompt", () => {
  it("renders the full orchestrator prompt for a project", () => {
    const template = [
      "You are the orchestrator for {{PROJECT_ID}}.",
      "Repo: {{PROJECT_REPO_URL}} (default {{PROJECT_DEFAULT_BRANCH}})",
      "Path: {{PROJECT_PATH}}",
      "Name: {{PROJECT_NAME}}",
    ].join("\n");
    const rendered = renderOrchestratorPrompt(template, fakeProject(), "/clone");
    expect(rendered).toContain("orchestrator for o-r");
    expect(rendered).toContain("Repo: https://github.com/o/r (default main)");
    expect(rendered).toContain("Path: /clone");
    expect(rendered).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });
});

describe("findAgentPromptPath", () => {
  const savedEnv = process.env["AGENTSKISS_AGENT_DIR"];

  afterEach(() => {
    if (savedEnv === undefined) delete process.env["AGENTSKISS_AGENT_DIR"];
    else process.env["AGENTSKISS_AGENT_DIR"] = savedEnv;
  });

  it("honors an explicit path", () => {
    expect(findAgentPromptPath("/custom/orchestrator.md")).toBe("/custom/orchestrator.md");
  });

  it("honors AGENTSKISS_AGENT_DIR", () => {
    process.env["AGENTSKISS_AGENT_DIR"] = "/agent-dir";
    expect(findAgentPromptPath()).toBe(path.join("/agent-dir", "prompts", "orchestrator.md"));
  });

  it("auto-discovers the repo's agent/prompts/orchestrator.md", () => {
    // This module lives in apps/daemon/src (or dist) inside the monorepo,
    // so the walk-up finds the real prompt template from issue #5.
    expect(findAgentPromptPath()).toMatch(/agent[\\/]prompts[\\/]orchestrator\.md$/);
  });
});
