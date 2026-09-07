// Ratchet for ESLint complexity budgets (warn-level rules in eslint.config.js).
// Violation ids are stable (no line numbers): "<rule>::<path>::<message>".
import { REPO_ROOT, ratchetCheck, run } from "./kiss-lib.mjs";

const BUDGET_RULES = new Set([
  "max-lines",
  "max-lines-per-function",
  "complexity",
  "max-depth",
]);

const res = run("npx", ["eslint", ".", "--format", "json"]);

let results;
try {
  results = JSON.parse(res.stdout);
} catch {
  console.error("eslint produced no parseable JSON on stdout:");
  console.error((res.stderr || res.stdout || "(empty)").slice(0, 2000));
  process.exit(1);
}

const ids = [];
for (const fileResult of results) {
  const relPath = fileResult.filePath.replace(`${REPO_ROOT}/`, "");
  for (const msg of fileResult.messages) {
    if (msg.severity === 1 && BUDGET_RULES.has(msg.ruleId)) {
      ids.push(`${msg.ruleId}::${relPath}::${msg.message}`);
    }
  }
}

ratchetCheck({
  tool: "complexity",
  baselineName: "eslint.json",
  currentIds: ids,
  hint: "Large/complex units belong to open refactor issues (#62, #71) — shrink them rather than baselining new debt.",
});
