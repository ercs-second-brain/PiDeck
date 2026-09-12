import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Persona } from "@pideck/shared";

const AGENT_DIR_ENV = "PD_AGENT_DIR";

export function agentDir(): string {
  const override = process.env[AGENT_DIR_ENV];
  if (override) return override;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "agent", "prompts"))) return join(dir, "agent");
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Cannot locate agent/prompts from ${import.meta.url}; set ${AGENT_DIR_ENV} to the agent directory`,
      );
    }
    dir = parent;
  }
}

export function loadShippedPrompt(persona: Persona): string {
  return readFileSync(join(agentDir(), "prompts", `${persona}.md`), "utf8");
}