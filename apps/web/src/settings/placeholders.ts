/**
 * The prompt placeholders the daemon substitutes when rendering a persona
 * prompt — the same table as agent/README.md. Shown beside the prompt editor
 * so an override can use them correctly.
 */

export interface PromptPlaceholder {
  token: string;
  description: string;
}

export const PromptPlaceholders: readonly PromptPlaceholder[] = [
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
];