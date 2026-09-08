/**
 * Polling machines behind the update banner (issues #76, #82, #89). Kept as
 * plain start/stop functions (no React) so the banner component stays thin
 * and the machines stay testable by inspection: each returns a cleanup that
 * stops its timers.
 *
 * - Idle (startIdleStatusPolling): forced fresh check on load/focus
 *   (debounced, issue #82) plus a slow cached-status fallback poll. A failed
 *   fetch (daemon restarting under the page — e.g. a CLI update) starts a
 *   backoff reconnect loop so the page notices the daemon's return.
 * - Updating (startApplyPolling): polls until the daemon is *actually
 *   running the target build* (`runningSha === targetSha`; `updateAvailable`
 *   flips false mid-update while the source is already reset but the old
 *   daemon still runs), with backoff while the API is down, a hard wait cap,
 *   and shim-reported failure — polling always stops once resolved.
 */

import type { UpdateStatusResponse } from "@pideck/shared";
import { apiGetUpdateStatus } from "../lib/api";

/** Idle polling fallback: slow — the daemon serves a cached gh check (~5 min
 * TTL) and fresh checks are forced on page load / window focus instead. */
const POLL_MS = 5 * 60_000;
/** Minimum spacing between forced (`?refresh=1`) checks (focus storms). */
const FORCE_DEBOUNCE_MS = 30_000;
/** Updating: first poll delay; doubles per failed poll (daemon down), capped. */
const APPLY_POLL_START_MS = 2_000;
const APPLY_POLL_MAX_MS = 15_000;
/** Idle reconnect after a failed status fetch: same sane backoff. */
const RECONNECT_START_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
/** Down longer than this → surface the recovery hint (but keep polling). */
export const RECOVERY_HINT_MS = 90_000;
/** Updating longer than this → give up polling and fall back to manual
 * instructions instead of hitting the endpoint forever. */
const MAX_APPLY_WAIT_MS = 20 * 60_000;
/** One short beat so the user sees "Update complete" before the page reloads. */
export const RELOAD_DELAY_MS = 1_200;

export interface IdleStatusPollingHandlers {
  /** Every successful status fetch, however it was triggered. */
  onStatus: (result: UpdateStatusResponse) => void;
  /** A fetch failed — the daemon is (probably temporarily) unreachable. */
  onUnreachable: () => void;
}

export function startIdleStatusPolling(handlers: IdleStatusPollingHandlers): () => void {
  let alive = true;
  let lastForce = 0;
  let delay = RECONNECT_START_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const load = (refresh: boolean): void => {
    if (refresh) {
      const now = Date.now();
      if (now - lastForce < FORCE_DEBOUNCE_MS) return;
      lastForce = now;
    }
    apiGetUpdateStatus(refresh)
      .then((result) => {
        if (alive) handlers.onStatus(result);
      })
      .catch(() => {
        if (!alive) return;
        handlers.onUnreachable();
        reconnectTimer = setTimeout(() => load(false), delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      });
  };
  load(true);
  const onFocus = (): void => load(true);
  window.addEventListener("focus", onFocus);
  const timer = setInterval(() => load(false), POLL_MS);
  return () => {
    alive = false;
    window.removeEventListener("focus", onFocus);
    clearTimeout(reconnectTimer);
    clearInterval(timer);
  };
}

export interface ApplyPollingHandlers {
  /** Poll reached the daemon but the update is not done yet. */
  onProgress: (result: UpdateStatusResponse) => void;
  /** Poll failed — `downMs` is time since the last successful poll. */
  onApiDown: (downMs: number) => void;
  /** 1/s heartbeat for the elapsed clock. */
  onTick: (elapsedMs: number) => void;
  /** The daemon runs the target build (or the shim reported done). */
  onResolved: (result: UpdateStatusResponse) => void;
  /** Shim-reported failure or the wait cap — stop polling. */
  onFailed: (message: string) => void;
}

export function startApplyPolling(targetSha: string, startedAt: number, handlers: ApplyPollingHandlers): () => void {
  let alive = true;
  let delay = APPLY_POLL_START_MS;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let lastOk = Date.now(); // for honest "daemon down for X" timing

  const ticker = setInterval(() => {
    if (alive) handlers.onTick(Date.now() - startedAt);
  }, 1_000);

  const tick = (): void => {
    if (Date.now() - startedAt > MAX_APPLY_WAIT_MS) {
      handlers.onFailed(
        "The update is taking unusually long — polling stopped. Run `pideck update` in a terminal or check `pideck service status`.",
      );
      return;
    }
    apiGetUpdateStatus()
      .then((result) => {
        if (!alive) return;
        lastOk = Date.now();
        const stage = result.applyProgress?.stage ?? null;
        if ((result.runningSha !== null && result.runningSha === targetSha) || stage === "done") {
          handlers.onResolved(result);
        } else if (stage === "failed") {
          handlers.onFailed(
            "The update failed while applying — run `pideck update` in a terminal and check `pideck logs` for details.",
          );
        } else {
          handlers.onProgress(result);
          delay = APPLY_POLL_START_MS;
          pollTimer = setTimeout(tick, delay);
        }
      })
      .catch(() => {
        if (!alive) return;
        handlers.onApiDown(Date.now() - lastOk);
        delay = Math.min(delay * 2, APPLY_POLL_MAX_MS);
        pollTimer = setTimeout(tick, delay);
      });
  };
  tick();
  return () => {
    alive = false;
    clearInterval(ticker);
    clearTimeout(pollTimer);
  };
}
