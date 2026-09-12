import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Placeholders, placeholdersIn, renderPrompt } from "./render.js";
import { loadShippedPrompt } from "./shipped.js";
import { Personas } from "@pideck/shared";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function readmePlaceholderTokens(): string[] {
  const readme = readFileSync(`${repoRoot}agent/README.md`, "utf8");
  return [...readme.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((match) => match[1] ?? "");
}

describe("Placeholders", () => {
  it("matches the placeholder table in agent/README.md exactly", () => {
    const tokens = new Set(readmePlaceholderTokens());
    expect(new Set(Placeholders)).toEqual(tokens);
    expect(Placeholders).toHaveLength(tokens.size);
  });
});

describe("placeholdersIn", () => {
  it("lists the placeholders a text uses", () => {
    expect(placeholdersIn("Issue {{ISSUE_NUMBER}} in {{REPO}} on {{ISSUE_NUMBER}}")).toEqual([
      "ISSUE_NUMBER",
      "REPO",
    ]);
  });

  it("throws on an unknown token", () => {
    expect(() => placeholdersIn("Hello {{NOT_A_THING}}")).toThrow(/Unknown prompt placeholder/);
  });
});

describe("renderPrompt", () => {
  it("substitutes every token", () => {
    const text = "Issue #{{ISSUE_NUMBER}} in {{REPO}}, merge mode {{AUTO_MERGE}}.";
    const vars = { ISSUE_NUMBER: "42", REPO: "acme/api", AUTO_MERGE: "false" };
    expect(renderPrompt(text, vars)).toBe("Issue #42 in acme/api, merge mode false.");
  });

  it("throws on an unknown token", () => {
    expect(() => renderPrompt("x {{TYPO}} y", {})).toThrow(/Unknown prompt placeholder/);
  });

  it("throws when a token has no value", () => {
    expect(() => renderPrompt("x {{REPO}} y", {})).toThrow(/Missing value for prompt placeholder/);
  });

  it("renders every shipped prompt without throwing when all placeholders are provided", () => {
    for (const persona of Personas) {
      const shipped = loadShippedPrompt(persona);
      const vars = Object.fromEntries(Placeholders.map((p) => [p, `x-${p.toLowerCase()}`]));
      const rendered = renderPrompt(shipped, vars);
      expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/);
      expect(rendered.length).toBeGreaterThan(0);
    }
  });
});