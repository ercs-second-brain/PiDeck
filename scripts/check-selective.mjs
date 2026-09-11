// Selective check runner shared by the pre-push hook (.husky/pre-push) and CI
// (.github/workflows/ci.yml) — one selection policy, no duplicated step lists.
//
// Given the files changed since a base ref, it picks the cheapest sufficient
// set of checks:
//
//   code or root-config changes (apps/, packages/, scripts/, kiss-baseline/,
//   package.json, tsconfig*, eslint/vitest/knip config, lockfiles)
//                                     -> `pnpm check` (full CI parity)
//   install/ only                     -> install shell suite (shellcheck + tests)
//   docs/, agent/, .github/, *.md ... -> nothing to verify
//
// The selection only ever skips work it cannot break: any change outside the
// known-safe categories falls through to the full check.

import { spawnSync } from "node:child_process";
import { run } from "./kiss-lib.mjs";

const FULL_CHECK = "full";
const INSTALL_CHECK = "install";
const NO_CHECK = "none";

const FULL_PREFIXES = ["apps/", "packages/", "scripts/", "kiss-baseline/"];
const FULL_ROOT_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "eslint.config.js",
  "vitest.config.ts",
  "knip.json",
]);
const INSTALL_PREFIX = "install/";

/** Changed files between a base ref and HEAD (three-dot diff), or null. */
function changedFiles(base) {
  const res = run("git", ["diff", "--name-only", `${base}...HEAD`]);
  if (res.status !== 0) return null;
  return res.stdout.split("\n").filter(Boolean);
}

/**
 * Base ref for the pushed range: the merge-base with the push target
 * (`@{push}`), falling back to origin/main. Returns null when neither is
 * resolvable (e.g. detached CI checkout) — the caller then runs everything.
 */
function autoBase() {
  for (const ref of ["@{push}", "origin/main"]) {
    const res = run("git", ["merge-base", "HEAD", ref]);
    if (res.status === 0) return res.stdout.trim();
  }
  return null;
}

/** Map changed files to the cheapest sufficient check bucket. */
function select(files) {
  let seenFull = false;
  let seenInstall = false;
  for (const file of files) {
    if (
      FULL_ROOT_FILES.has(file) ||
      /^tsconfig.*\.json$/.test(file) ||
      FULL_PREFIXES.some((prefix) => file.startsWith(prefix))
    ) {
      seenFull = true;
    } else if (file.startsWith(INSTALL_PREFIX)) {
      seenInstall = true;
    }
    // Everything else (docs, agent/, .github/, ...) needs no check.
  }
  if (seenFull) return FULL_CHECK;
  if (seenInstall) return INSTALL_CHECK;
  return NO_CHECK;
}

function execute(bucket) {
  if (bucket === NO_CHECK) {
    console.log("✓ selective: no checks needed for the changed files");
    return 0;
  }
  const cmd = bucket === FULL_CHECK ? ["check"] : ["--filter", "@pideck/install", "run", "build"];
  console.log(`▶ selective: pnpm ${cmd.join(" ")}`);
  const res = spawnSync("pnpm", cmd, { stdio: "inherit" });
  if (res.error) {
    console.error(`✗ selective: failed to run pnpm: ${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}

// --base <ref>: diff against an explicit ref (CI passes its merge-base).
// Without it: diff against the push target, falling back to the full check
// when the base cannot be determined.
const baseIndex = process.argv.indexOf("--base");
const explicitBase = baseIndex !== -1 ? process.argv[baseIndex + 1] : null;
const base = explicitBase ?? autoBase();

if (!base) {
  console.log("▶ selective: could not determine a base ref — running the full check");
  process.exit(execute(FULL_CHECK));
}

const files = changedFiles(base);
if (files === null) {
  console.log(`▶ selective: git diff against ${base} failed — running the full check`);
  process.exit(execute(FULL_CHECK));
}

console.log(`▶ selective: ${files.length} changed file(s) since ${base}`);
process.exit(execute(select(files)));
