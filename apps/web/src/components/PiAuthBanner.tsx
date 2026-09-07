import { useCallback, useEffect, useState } from "react";
import { apiGetPiAuth, errorMessage, type PiAuth } from "../lib/api";

/**
 * Persistent pi auth status banner (issue #57): shows which pi providers
 * have ready credentials and the configured startup model — and, when pi is
 * **not** ready, the actionable handoff (run `agentskiss onboard`, or launch
 * pi and use /login on the daemon host) with a re-check button. Workers
 * spawned while unauthenticated hold at `spawning` with their initial
 * prompt queued until a provider is ready (issue #56), so an unready banner
 * is worth acting on.
 */
export function PiAuthBanner() {
  const [auth, setAuth] = useState<PiAuth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  const check = useCallback(() => {
    setChecking(true);
    setError(null);
    apiGetPiAuth()
      .then(setAuth)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setChecking(false));
  }, []);

  useEffect(check, [check]);

  return (
    <section className="wizard-panel">
      <h2 className="panel-title">pi agent auth</h2>
      {checking && auth === null && <p className="empty">Checking pi auth on the daemon…</p>}
      {!checking && error !== null && (
        <>
          <p className="error-note">Could not reach the daemon: {error}</p>
          <button type="button" className="button" onClick={check}>
            Retry
          </button>
        </>
      )}
      {!checking && error === null && auth !== null && <PiAuthReport auth={auth} onRecheck={check} />}
    </section>
  );
}

/** Verdict display for the pi auth probe, shared by the banner and the onboarding wizard. */
export function PiAuthReport({ auth, onRecheck }: { auth: PiAuth; onRecheck: () => void }) {
  return (
    <div className="perm-report">
      {auth.ready ? (
        <p>
          <span className="badge badge-status-running">pi auth ready</span>{" "}
          <span className="perm-detail">
            providers: <code>{auth.providers.join(", ")}</code>
          </span>
        </p>
      ) : (
        <p className="error-note">
          pi has no ready provider on the daemon host. Run <code>agentskiss onboard</code> there, or launch{" "}
          <code>pi</code> and use <code>/login</code> to pick a provider and authenticate. Workers spawned before
          then stay at <em>spawning</em> with their initial prompt queued until auth is ready.
        </p>
      )}
      <p className="perm-verdict">
        Startup model:{" "}
        {auth.defaultModel === null ? (
          <strong>not configured</strong>
        ) : (
          <strong>
            <code>
              {auth.defaultProvider !== null ? `${auth.defaultProvider}/` : ""}
              {auth.defaultModel}
            </code>
          </strong>
        )}
        {auth.defaultModel === null && auth.ready && " (optional — run /model in pi and press Ctrl+S to save one)"}
      </p>
      <p className="perm-detail">{auth.detail}</p>
      <div className="wizard-actions">
        <button type="button" className="button" onClick={onRecheck}>
          Re-check
        </button>
      </div>
    </div>
  );
}
