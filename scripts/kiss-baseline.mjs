// Regenerate all kiss ratchet baselines from the current state of the repo:
//   kiss-baseline/knip.json     — unused files/exports/types (knip)
//   kiss-baseline/eslint.json   — complexity-budget warnings (ESLint)
//   kiss-baseline/jscpd.json    — copy-paste clone fingerprints (jscpd)
//
// Only run this to record EXISTING debt (first adoption, or after a fix so
// the baseline shrinks). New violations in CI must be fixed, not baselined.
import { REPO_ROOT, run, saveIds } from "./kiss-lib.mjs";

function knipIds() {
  const res = run("npx", ["knip", "--reporter", "json"]);
  const report = JSON.parse(res.stdout);
  const ids = [];
  for (const entry of report.issues) {
    const file = entry.file;
    for (const f of entry.files) ids.push(`file:${f.name}`);
    for (const e of entry.exports) ids.push(`export:${file}:${e.name}`);
    for (const t of entry.types) ids.push(`type:${file}:${t.name}`);
    for (const d of entry.duplicates) {
      const names = d.map((x) => x.name).join(",");
      ids.push(`duplicate-export:${file}:${names}`);
    }
    for (const dep of entry.dependencies) ids.push(`dep:${dep.name}`);
    for (const dep of entry.devDependencies) ids.push(`devDep:${dep.name}`);
    for (const b of entry.binaries) ids.push(`binary:${file}:${b.name}`);
  }
  return ids;
}

function eslintIds() {
  const BUDGET_RULES = new Set([
    "max-lines",
    "max-lines-per-function",
    "complexity",
    "max-depth",
  ]);
  const res = run("npx", ["eslint", ".", "--format", "json"]);
  const results = JSON.parse(res.stdout);
  const ids = [];
  for (const fileResult of results) {
    const relPath = fileResult.filePath.replace(`${REPO_ROOT}/`, "");
    for (const msg of fileResult.messages) {
      if (msg.severity === 1 && BUDGET_RULES.has(msg.ruleId)) {
        ids.push(`${msg.ruleId}::${relPath}::${msg.message}`);
      }
    }
  }
  return ids;
}

const knip = saveIds("knip.json", knipIds());
const eslint = saveIds("eslint.json", eslintIds());

const jscpd = run("npx", [
  "jscpd",
  "--silent",
  "--baseline",
  "kiss-baseline/jscpd.json",
  "--update-baseline",
  "apps",
  "packages",
  "install",
]);
if (jscpd.status !== 0) {
  console.error("jscpd --update-baseline failed");
  process.exit(jscpd.status || 1);
}

for (const [name, { added, removed }] of [
  ["knip", knip],
  ["eslint", eslint],
]) {
  console.log(
    `kiss-baseline/${name}.json: ${removed.length} entr${removed.length === 1 ? "y" : "ies"} trimmed, ${added.length} added`,
  );
  for (const id of removed) console.log(`  - ${id}`);
  for (const id of added) console.log(`  + ${id}`);
}
console.log("\nBaselines regenerated — commit kiss-baseline/ only for debt already owned by an open refactor issue.");
