/**
 * Node runtime vs pi's requirement (issue #202): pi 0.75+ needs Node >=
 * 22.19 (zstd support landed there), and a daemon booted on an older node
 * spawns pi sessions that crash on first request with
 * `zlib.createZstdDecompress is not a function` — invisible unless the
 * daemon says so. Mirrors pi's package.json `engines.node` pin, which the
 * installer enforces as `PD_NODE_MIN_VERSION` (install/lib/common.sh) and
 * the update path pairs with the pi reinstall (install/lib/update.sh).
 */

/** pi's package.json engines floor (install/lib/common.sh: PD_NODE_MIN_VERSION). */
export const PI_NODE_MIN_VERSION = "22.19.0";

/** The three numeric components of a `node -v`-style version, or `null`. */
export function parseNodeVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** `true` when the given node version satisfies pi's engines floor. */
export function nodeSupportsPi(version: string, minVersion: string = PI_NODE_MIN_VERSION): boolean {
  const actual = parseNodeVersion(version);
  const min = parseNodeVersion(minVersion);
  if (actual === null || min === null) return false;
  return (
    actual[0] > min[0] ||
    (actual[0] === min[0] && actual[1] > min[1]) ||
    (actual[0] === min[0] && actual[1] === min[1] && actual[2] >= min[2])
  );
}

/**
 * The `/api/status` fields (issue #202): which node this daemon process
 * actually runs on, and whether it is too old for the pi sessions it
 * spawns. The startup sequence (index.ts) logs a warning from the same
 * data so a stale private runtime is visible without hitting the API.
 */
export function nodeStatus(): { nodeVersion: string; nodeMinVersion: string; nodeTooOld: boolean } {
  const nodeVersion = process.version;
  return { nodeVersion, nodeMinVersion: PI_NODE_MIN_VERSION, nodeTooOld: !nodeSupportsPi(nodeVersion) };
}
