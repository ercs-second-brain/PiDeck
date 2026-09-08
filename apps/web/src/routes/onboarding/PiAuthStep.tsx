/**
 * Global onboarding step 1 — pi auth gate (issues #57, #183): workers are
 * pi coding agents spawned in tmux panes — they need working pi credentials
 * before any prompt can be delivered, so this step must pass before the
 * global flow proceeds. Renders the daemon probe state; the Continue button
 * stays disabled while no provider is ready.
 */
import type { PiAuth } from "../../lib/api";
import { DaemonError } from "../../components/DaemonError";
import { StepPanel } from "./StepPanel";

export function PiAuthStep(props: {
  checking: boolean;
  auth: PiAuth | null;
  error: string | null;
  onRecheck: () => void;
  onContinue: () => void;
}) {
  const { checking, auth, error, onRecheck, onContinue } = props;
  return (
    <StepPanel title="pi agent auth">
      <p className="empty">
        Workers are pi coding agents spawned in tmux panes — they need working pi credentials before any prompt
        can be delivered.
      </p>
      <PiAuthStatus checking={checking} auth={auth} error={error} onRecheck={onRecheck} />
      {!checking && error === null && auth !== null && (
        <div className="wizard-actions">
          {/* Issue #57: re-verify before proceeding — the gate cannot be
              clicked through while no provider is ready. */}
          <button
            type="button"
            className="button button-primary"
            disabled={!auth.ready}
            title={auth.ready ? undefined : "pi auth is not ready — complete the handoff above, then re-check"}
            onClick={onContinue}
          >
            Continue
          </button>
        </div>
      )}
    </StepPanel>
  );
}

/**
 * The pi probe's three states — checking, unreachable (retry), or the
 * verdict report — as rendered inside the pi auth step.
 */
function PiAuthStatus(props: {
  checking: boolean;
  auth: PiAuth | null;
  error: string | null;
  onRecheck: () => void;
}) {
  const { checking, auth, error, onRecheck } = props;
  return (
    <>
      {checking && auth === null && <p className="empty">Checking pi auth on the daemon…</p>}
      {!checking && error !== null && <DaemonError error={error} onRetry={onRecheck} />}
      {!checking && error === null && auth !== null && <PiAuthReport auth={auth} onRecheck={onRecheck} />}
    </>
  );
}

/** Verdict display for the pi auth probe. */
function PiAuthReport({ auth, onRecheck }: { auth: PiAuth; onRecheck: () => void }) {
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
          pi has no ready provider on the daemon host. Run <code>pideck onboard</code> there, or launch{" "}
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
