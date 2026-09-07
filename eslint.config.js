import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      // Local AO/agent session tooling — never part of the repo.
      ".pi/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Complexity budgets — enforced as warnings here and ratcheted to zero via
  // the "kiss" CI job (see scripts/kiss-complexity.mjs + kiss-baseline/).
  // Existing debt is baselined, not disabled per-file.
  {
    rules: {
      "max-lines": [
        "warn",
        { max: 300, skipBlankLines: true, skipComments: true },
      ],
      "max-lines-per-function": [
        "warn",
        { max: 100, skipBlankLines: true },
      ],
      complexity: ["warn", { max: 15 }],
      "max-depth": ["warn", { max: 4 }],
    },
  },
);
