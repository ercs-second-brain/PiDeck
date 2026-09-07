// Ratchet for knip (unused files / exports / types / dependencies).
// Violation ids are stable (no line numbers): e.g. "export:<path>:<name>".
import { ratchetCheck, run } from "./kiss-lib.mjs";

const res = run("npx", ["knip", "--reporter", "json"]);

let report;
try {
  report = JSON.parse(res.stdout);
} catch {
  console.error("knip produced no parseable JSON on stdout:");
  console.error((res.stderr || res.stdout || "(empty)").slice(0, 2000));
  process.exit(1);
}

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

ratchetCheck({
  tool: "knip",
  baselineName: "knip.json",
  currentIds: ids,
  hint: "Unused files/exports are usually deleted, not baselined. If an export is genuinely public API, wire it up or remove it.",
});
