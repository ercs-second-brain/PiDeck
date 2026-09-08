/**
 * Orchestrator prompt rendering (issue #12).
 *
 * The orchestration prompts live in the repo's `agent/prompts/` directory
 * (issue #5) and contain `{{PLACEHOLDER}}` tokens documented in
 * `agent/README.md`. This module is the ONE place that knows how to render
 * them for a concrete project:
 *
 * | Placeholder             | Substituted with                       |
 * |-------------------------|----------------------------------------|
 * | `{{PROJECT_ID}}`        | `Project.id`                           |
 * | `{{PROJECT_NAME}}`      | `Project.name`                         |
 * | `{{PROJECT_REPO_URL}}`  | `Project.repoUrl`                      |
 * | `{{PROJECT_DEFAULT_BRANCH}}` | `Project.defaultBranch`           |
 * | `{{PROJECT_PATH}}`      | local checkout path (the clone dir)    |
 * | `{{ORCHESTRATOR_SESSION_ID}}` | worker prompt only — not set here |
 *
 * The rendered prompt is written to a per-project file which the
 * orchestrator's pi session loads via `pi --append-system-prompt <file>`
 * (pi reads file contents when the argument is an existing path).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Project } from "@agentskiss/shared";

/** Placeholder keys the orchestrator prompt supports (agent/README.md). */
export type PromptPlaceholder =
  | "PROJECT_ID"
  | "PROJECT_NAME"
  | "PROJECT_REPO_URL"
  | "PROJECT_DEFAULT_BRANCH"
  | "PROJECT_PATH";

const PLACEHOLDER_PATTERN = /\{\{([A-Z0-9_]+)\}\}/g;

/**
 * Substitutes `{{KEY}}` tokens in a prompt template. Unknown keys are left
 * verbatim so a template and this module can evolve independently without
 * silently dropping content.
 */
export function renderTemplate(template: string, values: Partial<Record<PromptPlaceholder, string>>): string {
  return template.replace(PLACEHOLDER_PATTERN, (match, key: string) => {
    const value = values[key as PromptPlaceholder];
    return value !== undefined ? value : match;
  });
}

/**
 * The project-specific values for the orchestrator prompt placeholders.
 * `projectPath` is the local checkout (the project's clone dir).
 */
export function orchestratorPromptValues(
  project: Project,
  projectPath: string,
): Record<PromptPlaceholder, string> {
  return {
    PROJECT_ID: project.id,
    PROJECT_NAME: project.name,
    PROJECT_REPO_URL: project.repoUrl,
    PROJECT_DEFAULT_BRANCH: project.defaultBranch,
    PROJECT_PATH: projectPath,
  };
}

/** Renders the orchestrator prompt for a project. */
export function renderOrchestratorPrompt(
  template: string,
  project: Project,
  projectPath: string,
): string {
  return renderTemplate(template, orchestratorPromptValues(project, projectPath));
}

/**
 * Resolves the source path of the orchestrator prompt template:
 * an explicit argument wins, then `PD_AGENT_DIR` (set by service
 * units when the checkout lives outside the default location), then a
 * walk up from this module toward the repo root looking for
 * `agent/prompts/orchestrator.md` (works from both `src/` and `dist/`).
 */
export function findAgentPromptPath(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const envDir = process.env["PD_AGENT_DIR"];
  if (envDir !== undefined && envDir.length > 0) {
    return path.join(envDir, "prompts", "orchestrator.md");
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(dir, "agent", "prompts", "orchestrator.md");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: the repo root relative to the current working directory.
  return path.join(process.cwd(), "agent", "prompts", "orchestrator.md");
}
