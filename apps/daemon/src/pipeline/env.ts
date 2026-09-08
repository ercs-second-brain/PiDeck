/**
 * Watcher/pipeline environment knobs (issue #46).
 *
 * API rate budget (why the knobs exist): per enabled project, every poll
 * costs one REST issues-list call (issue watcher, only when auto-spawn is
 * enabled) + one batched GraphQL open-PR listing (PR watcher) + the PR
 * loop's per-tracked-PR enrichment (one REST pull + one check-run/review
 * batch + one comments call per tracked PR). At the default 30s interval
 * an idle project costs ~4 calls/30s; size `PD_WATCHER_POLL_INTERVAL_MS`
 * accordingly.
 *
 * Environment:
 * - `PD_WATCHER_ENABLED`            set to `0`/`false` to disable
 *                                           the watcher/pipeline loop (default on)
 * - `PD_WATCHER_POLL_INTERVAL_MS`   poll interval for all watchers
 *                                           and the PR loop (default 30s)
 */

import { DEFAULT_POLL_INTERVAL_MS } from "../github/watch.js";

/** Resolves the watcher knobs from the environment (options win over env). */export function watcherOptionsFromEnv(
  env: NodeJS.ProcessEnv,
  overrides: { enabled?: boolean; pollIntervalMs?: number } = {},
): { enabled: boolean; pollIntervalMs: number } {
  const enabledFlag = env["PD_WATCHER_ENABLED"]?.trim().toLowerCase();
  const enabled =
    overrides.enabled ??
    (enabledFlag === undefined || enabledFlag.length === 0 ? true : !(enabledFlag === "0" || enabledFlag === "false"));
  const rawInterval = Number(env["PD_WATCHER_POLL_INTERVAL_MS"]);
  const pollIntervalMs =
    overrides.pollIntervalMs ?? (Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : DEFAULT_POLL_INTERVAL_MS);
  return { enabled, pollIntervalMs };
}
