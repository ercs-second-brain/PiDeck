// Enforces the "baseline may only shrink" rule for jscpd (the new-clone gate
// itself lives in the `kiss:dup` script): re-runs jscpd with
// --update-baseline and verifies the baseline file did not change during the
// run. Since the new-clone gate already passed, --update-baseline can only
// REMOVE stale fingerprints — any change means the committed baseline is
// stale and must be trimmed (pnpm kiss:baseline) and committed.
import { die, REPO_ROOT, run } from "./kiss-lib.mjs";
import { readFileSync, writeFileSync } from "node:fs";

const BASELINE = "kiss-baseline/jscpd.json";
const PATHS = ["apps", "packages", "install"];

const before = readFileSync(REPO_ROOT + "/" + BASELINE, "utf8");
run("npx", ["jscpd", "--silent", "--baseline", BASELINE, "--update-baseline", ...PATHS]);
const after = readFileSync(REPO_ROOT + "/" + BASELINE, "utf8");

if (before !== after) {
  // Restore the committed state so the tree stays clean; CI fails and local
  // users regenerate with `pnpm kiss:baseline`.
  writeFileSync(REPO_ROOT + "/" + BASELINE, before);
  die(
    "jscpd: kiss-baseline/jscpd.json contained stale fingerprints (clones that no longer exist) — " +
      "baselines may only shrink. Run \"pnpm kiss:baseline\" and commit kiss-baseline/.",
  );
}

console.log("✓ jscpd: baseline up to date (no stale fingerprints)");
