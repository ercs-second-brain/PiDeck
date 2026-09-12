export const Placeholders = [
  "PROJECT_ID",
  "PROJECT_NAME",
  "REPO",
  "DEFAULT_BRANCH",
  "PROJECT_PATH",
  "ISSUE_NUMBER",
  "PR_NUMBER",
  "SESSION_ID",
  "AUTO_MERGE",
  "ORCHESTRATOR_SESSION_ID",
] as const;

export type Placeholder = (typeof Placeholders)[number];

export type PromptVars = Partial<Record<Placeholder, string>>;

const TOKEN_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

export function placeholdersIn(text: string): Placeholder[] {
  const found = new Set<Placeholder>();
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[1] as Placeholder;
    if (!isPlaceholder(token)) {
      throw new Error(`Unknown prompt placeholder {{${token}}}`);
    }
    found.add(token);
  }
  return [...found];
}

function isPlaceholder(token: string): token is Placeholder {
  return (Placeholders as readonly string[]).includes(token);
}

export function renderPrompt(text: string, vars: PromptVars): string {
  return text.replace(TOKEN_RE, (raw, token: string) => {
    if (!isPlaceholder(token)) {
      throw new Error(`Unknown prompt placeholder ${raw}`);
    }
    const value = vars[token];
    if (value === undefined) {
      throw new Error(`Missing value for prompt placeholder ${raw}`);
    }
    return value;
  });
}
