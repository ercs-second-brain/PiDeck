import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { isTerminalUpdateStage, UPDATE_STAGE_TEXT, type UpdateStatusResponse } from "@pideck/shared";
import { apiApplyUpdate, errorMessage } from "../lib/api";
import { startApplyPolling, startIdleStatusPolling } from "./update-polling";
import { UpdateApplyModal } from "./UpdateApplyModal";

/**
 * Self-update popup (issues #55, #76, #82, #89, #260): polls the daemon's
 * update status and, when a newer upstream revision exists, offers
 * click-to-update. Issue #260 (B8): the surface is a compact popup anchored
 * on the sidebar above the settings entry (rendered through the picker's
 * footer slot), not a full-width banner.
 *
 * - Polling is cheap for gh: the daemon serves a cached check (~5 min
 *   re-check, apps/daemon/src/api/update.ts), and the banner forces a fresh
 *   check (`?refresh=1`) on page load and window focus (debounced — no
 *   polling loops), so new updates show up within seconds of visiting the
 *   page instead of up to an hour. The background poll runs every 15s
 *   (issue #451): the daemon's fresh-per-request fields — the active-worker
 *   gate count and the apply progress — used to trail reality by up to the
 *   previous 5-minute poll interval.
 * - 'Up to date' is deliberately quiet — no banner at all.
 * - The update button is disabled while any worker is in an active status;
 *   the count comes from the daemon (same `ACTIVE_WORKER_STATUSES` gate the
 *   apply endpoint enforces server-side). Orchestrator sessions are not
 *   workers and never block.
 *
 * Updating state machine (issue #89 — survives the daemon restart; the
 * polling/backoff machines live in update-polling.ts):
 * - Applying POSTs `/api/update/apply`, which spawns `pideck update`
 *   detached and returns immediately; the daemon restarts mid-apply, so the
 *   banner flips to an 'updating…' state and polls until the daemon is
 *   *actually running the new build* — resolution keys on `runningSha`
 *   (captured at daemon boot) equalling the target SHA, never on
 *   `updateAvailable`, which flips false mid-update while the source
 *   checkout is already reset but the old daemon still runs.
 * - During the (multi-minute) rebuild the shim writes a live stage file the
 *   daemon serves as `applyProgress`; the user sees that stage plus an
 *   honest elapsed timer instead of a silent wait.
 * - While a banner-initiated apply runs this state is a **full-screen modal
 *   over the dimmed app** (issue #113, `UpdateApplyModal`) — the update is
 *   app-wide, so the presentation matches the scope. Normal browsing is
 *   unaffected.
 * - When the update is done, polling stops and the page reloads straight
 *   into the new build — no completion message (issue #450, user decision:
 *   it "can just go away"). A page that merely had the daemon restart under
 *   it (CLI update path) detects the new `runningSha` after the API returns
 *   and offers a one-click reload instead of auto-navigating mid-work.
 */

/** Live state of a banner-initiated apply while the daemon rebuilds. */
export interface UpdatingState {
  /** Full SHA the apply is moving to. */
  targetSha: string;
  /** `Date.now()` when the apply was accepted. */
  startedAt: number;
  /** Elapsed since `startedAt` (re-rendered ~1/s by the polling heartbeat). */
  elapsedMs: number;
  /** Last stage the update shim reported (`null` before the first poll). */
  stage: string | null;
  /** Whether the last poll reached the daemon. */
  apiUp: boolean;
  /** While the API is down: ms since the last successful poll. */
  downMs: number;
}

/**
 * An apply failure, tagged with the SHA the failed cycle targeted (issue
 * #186): the error belongs to that cycle only — a NEW upstream SHA starts a
 * fresh detection cycle and the old error must not render next to it.
 */
export interface ApplyError {
  /** Target SHA of the failed apply (`null` when the apply never got one). */
  sha: string | null;
  /** Human-readable failure. */
  message: string;
}

/**
 * Drops a prior apply cycle's error once the daemon reports a different
 * upstream SHA (issue #186): that detection starts a clean cycle, so the
 * stale "update failed" must not leak into the new available-banner. An
 * error whose SHA still matches (or an untagged one) persists — the failed
 * apply stays explained until the user retries or the SHA moves.
 */
export function clearStaleApplyError(error: ApplyError | null, result: UpdateStatusResponse): ApplyError | null {
  if (error === null) return null;
  if (result.remoteSha !== null && result.remoteSha !== error.sha) return null;
  return error;
}

/** Human text for a shim stage; honest fallbacks when nothing is known yet. */
export function updatingText(stage: string | null, apiUp: boolean): string {
  if (stage !== null && UPDATE_STAGE_TEXT[stage] !== undefined) return UPDATE_STAGE_TEXT[stage];
  if (stage !== null) return `update stage: ${stage}`;
  if (!apiUp) return "daemon restarting — it will come back with the new build";
  return "applying the update";
}

/** Compact elapsed clock for the updating banner ("42s", "3m 05s", "1h 02m"). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatusResponse | null>(null);
  const [phase, setPhase] = useState<"idle" | "updating">("idle");
  const [updating, setUpdating] = useState<UpdatingState | null>(null);
  /** CLI-path detection: a build is live whose SHA differs from the page's. */
  const [reloadSha, setReloadSha] = useState<string | null>(null);
  /** Idle page, API unreachable (e.g. a CLI update restarted the daemon). */
  const [reconnecting, setReconnecting] = useState(false);
  /** Apply failure (gate conflict, spawn error, apply run) — cycle-tagged. */
  const [error, setError] = useState<ApplyError | null>(null);
  /** The build SHA this page was loaded with; `null` until the first status. */
  const bootShaRef = useRef<string | null>(null);

  const targetSha = updating?.targetSha ?? null;
  const startedAt = updating?.startedAt ?? 0;

  // Adopt every successful status fetch: first one anchors the boot SHA; a
  // later different runningSha means a new build is live (CLI update path).
  const adopt = useCallback((result: UpdateStatusResponse): void => {
    setStatus(result);
    setReconnecting(false);
    // A new upstream SHA is a fresh detection cycle (issue #186): a prior
    // apply's failure belongs to the old cycle and must not render here.
    setError((e) => clearStaleApplyError(e, result));
    if (bootShaRef.current === null) {
      bootShaRef.current = result.runningSha;
    } else if (result.runningSha !== null && result.runningSha !== bootShaRef.current) {
      setReloadSha(result.runningSha);
    } else {
      setReloadSha(null);
    }
  }, []);

  // Idle: fresh check on load/focus, slow cached fallback, and a backoff
  // reconnect loop whenever the API is unreachable (CLI-update restart).
  useEffect(() => {
    if (phase !== "idle") return;
    return startIdleStatusPolling({ onStatus: adopt, onUnreachable: () => setReconnecting(true) });
  }, [phase, adopt]);

  // Updating: poll until the daemon runs the target build (see docblock).
  useEffect(() => {
    if (phase !== "updating" || targetSha === null) return;
    return startApplyPolling(targetSha, startedAt, {
      onProgress: (result) =>
        setUpdating((u) =>
          u === null ? u : { ...u, stage: result.applyProgress?.stage ?? null, apiUp: true, downMs: 0 },
        ),
      onApiDown: (downMs) => setUpdating((u) => (u === null ? u : { ...u, apiUp: false, downMs })),
      onTick: (elapsedMs) => setUpdating((u) => (u === null ? u : { ...u, elapsedMs })),
      onResolved: (result) => {
        setStatus(result);
        setUpdating(null);
        setReloadSha(null);
        setError(null); // the apply completed — its cycle is fully closed
        setPhase("idle");
        // Issue #450: no completion message — reload into the new build
        // right away (the reload replaces the whole page mid-handler).
        window.location.reload();
      },
      onFailed: (message) => {
        setUpdating(null);
        setPhase("idle");
        setError({ sha: targetSha, message });
      },
    });
  }, [phase, targetSha, startedAt]);

  const apply = useCallback(async () => {
    setError(null);
    try {
      await apiApplyUpdate();
      const sha = status?.remoteSha ?? null;
      if (sha === null) return; // nothing tracked to move to — quiet no-op
      setUpdating({ targetSha: sha, startedAt: Date.now(), elapsedMs: 0, stage: null, apiUp: true, downMs: 0 });
      setPhase("updating");
    } catch (err) {
      // 409 (a worker went active between poll and click) and spawn failures
      // land here — show the reason, stay clickable.
      setError({ sha: status?.remoteSha ?? null, message: errorMessage(err) });
    }
  }, [status]);

  const onReload = useCallback((): void => {
    window.location.reload();
  }, []);

  return (
    <UpdateBannerView
      status={status}
      phase={phase}
      updating={updating}
      reloadSha={reloadSha}
      reconnecting={reconnecting}
      error={error?.message ?? null}
      onApply={() => void apply()}
      onReload={onReload}
    />
  );
}

export interface UpdateBannerViewProps {
  status: UpdateStatusResponse | null;
  phase: "idle" | "updating";
  /** Live apply state (`null` while not banner-initiated-updating). */
  updating: UpdatingState | null;
  /** New build's SHA detected after a CLI-update daemon restart. */
  reloadSha: string | null;
  /** The daemon is unreachable from the idle page (CLI-update restart). */
  reconnecting: boolean;
  /** Failure from the apply click (gate conflict, spawn error) or the apply run. */
  error: string | null;
  onApply: () => void;
  onReload: () => void;
}

/**
 * A live (non-terminal) apply stage from the daemon's status, or `null` when
 * no apply is running (issue #221): `done`/`failed` are terminal — they stay
 * with the apply flow's own error/completion handling, not a phantom strip.
 */
function activeApplyProgress(status: UpdateStatusResponse | null): UpdateStatusResponse["applyProgress"] {
  const progress = status?.applyProgress ?? null;
  if (progress === null || isTerminalUpdateStage(progress.stage)) return null;
  return progress;
}

/** Idle-page strip for a genuinely running apply the page didn't initiate. */
function ActiveApplyStrip({ stage }: { stage: string }) {
  return (
    <div className="update-banner updating" role="status">
      {updatingText(stage, true)}&hellip;
    </div>
  );
}

/** CLI-path completion: reload into the new build on click. */
function ReloadStrip({ sha, onReload }: { sha: string; onReload: () => void }) {
  return (
    <div className="update-banner" role="status">
      PiDeck was updated to <code>{sha.slice(0, 7)}</code> while this page was open — reload to switch to the new build.
      <button className="update-apply" type="button" onClick={onReload}>
        Reload new build
      </button>
    </div>
  );
}

/** Idle-page strip for a failed check — visible, not silent (issue #221). */
function CheckErrorStrip({ error }: { error: string }) {
  return (
    <div className="update-banner" role="alert">
      <span className="update-banner-error">Update check failed: {error}</span>
    </div>
  );
}

/**
 * Daemon on a node too old for pi (issue #202 class): every spawned session
 * would crash on first request (`zlib.createZstdDecompress is not a
 * function`) — warn loudly here instead of letting the crash be invisible.
 */
function NodeTooOldStrip({ nodeVersion, minVersion }: { nodeVersion: string; minVersion: string }) {
  return (
    <div className="update-banner" role="alert">
      <span className="update-banner-error">
        The daemon runs node {nodeVersion}, which is too old for pi (needs &gt;= {minVersion}) — spawned agents will
        crash on start. Run <code>pideck update</code> to refresh the private runtime and reinstall pi.
      </span>
    </div>
  );
}

/**
 * The offer to apply a detected update, with the server's worker gate (issue
 * #410): one compact row — a primary Update now button, no body text. While
 * agents are active the button is disabled and the gate warning lives in a
 * CSS tooltip (`.update-tooltip`, revealed on hover/focus-within), linked to
 * the button via `aria-describedby` so assistive tech reads it too; the full
 * `repo@ref` rides as a native title on the short SHA. The apply failure
 * stays a visible red line — it must not hide behind a hover (issue #221).
 */
function UpdateAvailableStrip({
  remoteSha,
  repo,
  ref,
  activeWorkers,
  error,
  onApply,
}: {
  remoteSha: string;
  repo: string;
  ref: string;
  activeWorkers: number;
  error: string | null;
  onApply: () => void;
}) {
  const blocked = activeWorkers > 0;
  const hintId = "update-blocked-hint";
  return (
    <div className="update-banner update-offer" role="status">
      <span className="update-offer-label">
        Update available <code title={`${repo}@${ref}`}>{remoteSha.slice(0, 7)}</code>
      </span>
      {error !== null && <span className="update-banner-error">{error}</span>}
      <span className="update-apply-wrap">
        <button
          className="update-apply"
          type="button"
          onClick={onApply}
          disabled={blocked}
          aria-describedby={blocked ? hintId : undefined}
        >
          Update now
        </button>
        {blocked && (
          <span id={hintId} role="tooltip" className="update-tooltip">
            {`${activeWorkers} agent${activeWorkers === 1 ? "" : "s"} still working — updating waits until all agents are idle.`}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * Pure view for the popup states — kept separate so tests exercise the
 * rendering without React effects/fetch. The live apply renders through
 * {@link UpdateApplyModal} (issue #113); the completion beat is gone
 * (issue #450 — the page reloads straight into the new build). Every other
 * state is a compact popup (issue #260): the strips stack inside an
 * `.update-popup` wrapper anchored above the sidebar's settings entry;
 * quiet when up to date / loading (`null` — no empty popup shell).
 */
export function UpdateBannerView({
  status,
  phase,
  updating,
  reloadSha,
  reconnecting,
  error,
  onApply,
  onReload,
}: UpdateBannerViewProps) {
  // A banner-initiated apply renders in the modal over the dimmed app; on
  // resolution the wrapper reloads the page directly (issue #450).
  if (phase === "updating" && updating !== null) {
    return <UpdateApplyModal updating={updating} />;
  }

  let content: ReactNode;
  // Idle page lost the daemon (e.g. a CLI update restarted it): say so, the
  // reconnect poll picks the daemon's return up and offers the reload below.
  if (reconnecting) {
    content = (
      <div className="update-banner updating" role="status">
        Connection to the daemon was lost — waiting for it to come back&hellip;
      </div>
    );
  } else if (reloadSha !== null) {
    // CLI-path completion: a build with a different SHA is live; reload into
    // it on click (auto-navigating mid-work — e.g. an attached terminal — is
    // rude).
    content = <ReloadStrip sha={reloadSha} onReload={onReload} />;
  } else {
    // Issue #221: a genuinely running apply (CLI-initiated, or the daemon
    // rebooted mid-apply under this page) must be visible — the daemon only
    // serves live, non-terminal stages here, so show the real stage instead
    // of pretending all is quiet. Banner-initiated applies render through the
    // modal above; this strip covers every other observer.
    const progress = activeApplyProgress(status);
    // Issue #221: a failed check must be visible, not silent — before this,
    // an error state (stale apply progress, broken source checkout, gh PATH
    // failure) rendered NO surface at all and looked exactly like "up to
    // date".
    if (progress !== null) {
      content = <ActiveApplyStrip stage={progress.stage} />;
    } else if (status?.error != null) {
      content = <CheckErrorStrip error={status.error} />;
    } else {
      // Idle-page popup: node-too-old warning plus the update offer. Called
      // directly (not as a component) so a quiet state yields `null` — no
      // empty popup shell.
      content = idleStrips({ status, error, onApply });
    }
  }
  if (content === null) return null;
  return <div className="update-popup">{content}</div>;
}

/**
 * The idle-page tail strips: the node-too-old alert (issue #202 class — a
 * daemon whose node cannot run pi gets a loud warning, on its own or stacked
 * above an update offer; the single warning surface, #236) and the
 * update-available strip. Quiet (`null`) when up to date / loading.
 * Plain render function (no hooks) — the caller needs the `null` value to
 * suppress the popup wrapper, which a component element cannot express.
 */
function idleStrips(props: {
  status: UpdateStatusResponse | null;
  error: string | null;
  onApply: () => void;
}): ReactNode {
  const { status, error, onApply } = props;
  if (status === null) return null;
  const nodeStrip = status.nodeTooOld ? (
    <NodeTooOldStrip nodeVersion={status.nodeVersion} minVersion={status.nodeMinVersion} />
  ) : null;
  if (status.updateAvailable !== true || status.remoteSha === null) return nodeStrip;
  const updateStrip = (
    <UpdateAvailableStrip
      remoteSha={status.remoteSha}
      repo={status.repo}
      ref={status.ref}
      activeWorkers={status.activeWorkers}
      error={error}
      onApply={onApply}
    />
  );
  return nodeStrip === null ? updateStrip : (
    <>
      {nodeStrip}
      {updateStrip}
    </>
  );
}