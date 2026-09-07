// Enforces the "baseline may only shrink" rule for jscpd (the new-clone gate
// itself lives in the `kiss:dup` script): re-runs jscpd with
// --update-baseline and verifies the committed baseline file did not change.
// Since the new-clone gate already passed, --update-baseline can only REMOVE
// stale fingerprints — a diff means the baseline is stale and must be
// trimmed (pnpm kiss:baseline) and committed.
import { die, run } from "./kiss-lib.mjs";

const BASELINE = "kiss-baseline/jscpd.json";
const PATHS = ["apps", "packages", "install"];

run("npx", ["jscpd", "--silent", "--baseline", BASELINE, "--update-baseline", ...PATHS]);
const diff = run("git", ["diff", "--exit-code", "--", BASELINE]);
if (diff.status !== 0) {
  run("git", ["checkout", "--", BASELINE]);
  die(
    "jscpd: kiss-baseline/jscpd.json contains stale fingerprints (clones that no longer exist) — " +
      "baselines may only shrink. Run \"pnpm kiss:baseline\" and commit kiss-baseline/.",
  );
}

console.log("✓ jscpd: baseline up to date (no stale fingerprints)");
