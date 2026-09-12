/**
 * The prompt placeholders the daemon substitutes when rendering a persona
 * prompt — the single source for the daemon's renderer, the web settings
 * copy, and the agent/README.md table (checked by a test).
 */

export const PromptPlaceholders = [
  { token: "PROJECT_ID", description: "Project id (slug)" },
  { token: "PROJECT_NAME", description: "Project display name" },
  { token: "REPO", description: "owner/repo on GitHub" },
  { token: "DEFAULT_BRANCH", description: "Project's default branch" },
  { token: "PROJECT_PATH", description: "Local working-copy path" },
  { token: "ISSUE_NUMBER", description: "The worker's assigned issue number" },
  { token: "PR_NUMBER", description: "The reviewer's PR number" },
  { token: "SESSION_ID", description: "This session's id" },
  { token: "AUTO_MERGE", description: "true or false — the project's merge mode" },
  { token: "ORCHESTRATOR_SESSION_ID", description: "The project orchestrator's session id" },
] as const;

export type PromptPlaceholder = (typeof PromptPlaceholders)[number];