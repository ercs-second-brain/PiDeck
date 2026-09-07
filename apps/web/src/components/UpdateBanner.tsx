import { useCallback, useEffect, useState } from "react";
import type { UpdateStatusResponse } from "@agentskiss/shared";
import { apiApplyUpdate, apiGetUpdateStatus, errorMessage } from "../lib/api";

/**
 * Self-update banner (issues #55, #76, #82): polls the daemon's update status
 * and, when a newer upstream revision exists, offers click-to-update.
 *
 * - Polling is cheap for gh: the daemon serves a cached check (~5 min
 *   re-check, apps/daemon/src/api/update.ts), and the banner forces a fresh
 *   check (`?refresh=1`) on page load and window focus (debounced — no
 *   polling loops), so new updates show up within seconds of visiting the
 *   page instead of up to an hour.
 * - 'Up to date' is deliberately quiet — no banner at all.
 * - The update button is disabled (with a hint) while any worker is in an
 *   active status; the count comes from the daemon (same
 *   `ACTIVE_WORKER_STATUSES` gate the apply endpoint enforces server-side).
 *   Orchestrator sessions are not workers and never block.
 * - Applying POSTs `/api/update/apply`, which spawns `agentskiss update`
 *   detached and returns immediately — the daemon restarts mid-apply, so the
 *   banner flips to an 'updating…' state and polls until the daemon
 *   reappears reporting the new SHA. If it stays down for a while, a
 *   recovery hint points at the CLI.
 */

/**
 * Idle polling fallback: slow — the daemon serves a cached gh check (~5 min
 * TTL) and fresh checks are forced on page load / window focus instead.
 */
const POLL_MS = 5 * 60_000;
/** Minimum spacing between forced (`?refresh=1`) checks (focus storms). */
const FORCE_DEBOUNCE_MS = 30_000;
/** While updating: wait for the daemon to come back with the new build. */
const APPLY_POLL_MS = 2_000;
/** Down longer than this → surface the recovery hint (but keep polling). */
const RECOVERY_HINT_MS = 90_000;

export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatusResponse | null>(null);
  const [phase, setPhase] = useState<"idle" | "updating">("idle");
  const [targetSha, setTargetSha] = useState<string | null>(null);
  const [downMs, setDownMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Idle: force a fresh check on page load and window focus (debounced —
  // no polling loops), plus a slow background poll of the daemon-cached
  // status as a fallback.
  useEffect(() => {
    if (phase !== "idle") return;
    let alive = true;
    let lastForce = 0;
    const load = (refresh: boolean) => {
      if (refresh) {
        const now = Date.now();
        if (now - lastForce < FORCE_DEBOUNCE_MS) return;
        lastForce = now;
      }
      apiGetUpdateStatus(refresh)
        .then((result) => {
          if (alive) setStatus(result);
        })
        .catch(() => {
          /* transient (daemon restarting) — keep the last status */
        });
    };
    load(true);
    const onFocus = () => load(true);
    window.addEventListener("focus", onFocus);
    const timer = setInterval(() => load(false), POLL_MS);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [phase]);

  // Updating: poll until the daemon returns reporting the new build.
  useEffect(() => {
    if (phase !== "updating") return;
    let alive = true;
    let lastOk = Date.now();
    setDownMs(0);
    const tick = () => {
      apiGetUpdateStatus()
        .then((result) => {
          if (!alive) return;
          lastOk = Date.now();
          setDownMs(0);
          if (!result.updateAvailable) {
            // New build confirmed (or the check now says up to date).
            setStatus(result);
            setTargetSha(null);
            setPhase("idle");
          }
        })
        .catch(() => {
          if (alive) setDownMs(Date.now() - lastOk);
        });
    };
    tick();
    const timer = setInterval(tick, APPLY_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase]);

  const apply = useCallback(async () => {
    setError(null);
    try {
      await apiApplyUpdate();
      setTargetSha(status?.remoteSha ?? null);
      setPhase("updating");
    } catch (err) {
      // 409 (a worker went active between poll and click) and spawn failures
      // land here — show the reason, stay clickable.
      setError(errorMessage(err));
    }
  }, [status]);

  return (
    <UpdateBannerView status={status} phase={phase} targetSha={targetSha} downMs={downMs} error={error} onApply={() => void apply()} />
  );
}

export interface UpdateBannerViewProps {
  status: UpdateStatusResponse | null;
  phase: "idle" | "updating";
  /** Short SHA the apply is moving to (`null` until accepted). */
  targetSha: string | null;
  /** How long the daemon has been unreachable during apply (`null` while reachable). */
  downMs: number | null;
  /** Failure from the apply click (gate conflict, spawn error). */
  error: string | null;
  onApply: () => void;
}

/**
 * Pure view for the banner states — kept separate so tests exercise the
 * rendering without React effects/fetch.
 */
export function UpdateBannerView({ status, phase, targetSha, downMs, error, onApply }: UpdateBannerViewProps) {
  if (phase === "updating") {
    return (
      <div className="update-banner updating" role="status">
        Updating agentsKISS{targetSha !== null ? <> to <code>{targetSha.slice(0, 7)}</code></> : null}&hellip; the daemon
        restarts as part of the update.
        {downMs !== null && downMs > RECOVERY_HINT_MS && (
          <span className="update-banner-hint">
            {" "}Still waiting — if this page doesn't recover within a few minutes, run <code>agentskiss update</code> in a
            terminal or check <code>agentskiss service status</code>.
          </span>
        )}
      </div>
    );
  }

  // Quiet when up to date / check failed / loading.
  if (status === null || status.updateAvailable !== true || status.remoteSha === null) return null;

  const active = status.activeWorkers;
  const blocked = active > 0;
  return (
    <div className="update-banner" role="status">
      Update available — new version <code>{status.remoteSha.slice(0, 7)}</code> on{" "}
      <code>{`${status.repo}@${status.ref}`}</code>.
      {error !== null && <span className="update-banner-error"> {error}</span>}
      <button className="update-apply" type="button" onClick={onApply} disabled={blocked}>
        Update now
      </button>
      {blocked && (
        <span className="update-banner-hint">{` ${active} agent${active === 1 ? "" : "s"} still working — updating waits until all agents are idle.`}</span>
      )}
    </div>
  );
}
