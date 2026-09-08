/**
 * Step 2 — gh permission check: the daemon-side probe via `GET /api/gh-auth`.
 * Continuation is always allowed (cloning needs no extra scopes); the report
 * explains what repo creation will be able to do.
 */
import type { GhAuth } from "../../lib/api";
import { DaemonError } from "../../components/DaemonError";
import { StepPanel } from "./StepPanel";

export function GhPermissionStep(props: {
  checking: boolean;
  auth: GhAuth | null;
  error: string | null;
  onRecheck: () => void;
  onContinue: () => void;
}) {
  const { checking, auth, error, onRecheck, onContinue } = props;
  return (
    <StepPanel title="gh permission check">
      {checking && <p className="empty">Checking gh authentication on the daemon…</p>}
      {!checking && error !== null && <DaemonError error={error} onRetry={onRecheck} />}
      {!checking && error === null && auth !== null && (
        <>
          <PermissionReport auth={auth} />
          <div className="wizard-actions">
            <button type="button" className="button button-primary" onClick={onContinue}>
              Continue
            </button>
            <button type="button" className="button" onClick={onRecheck}>
              Re-check
            </button>
          </div>
        </>
      )}
    </StepPanel>
  );
}

/** Verdict display for the gh permission probe. */
function PermissionReport({ auth }: { auth: GhAuth }) {
  return (
    <div className="perm-report">
      {auth.authenticated ? (
        <p>
          <span className="badge badge-open">gh authenticated</span>{" "}
          {auth.login && (
            <span>
              as <code>{auth.login}</code>{" "}
            </span>
          )}
          <span className="perm-detail">
            (token: <code>{auth.tokenSource}</code>)
          </span>
        </p>
      ) : (
        <p className="error-note">
          gh is not authenticated on the daemon host. Run <code>gh auth login</code> there, then re-check. You can
          still continue — cloning needs no extra scopes.
        </p>
      )}
      <p className={`perm-verdict perm-${auth.canCreateRepos}`}>
        Create repositories: <strong>{auth.canCreateRepos}</strong>
        {auth.canCreateRepos === "unknown" && " (token scopes not reported — creation will be attempted and verified)"}
      </p>
      <p className="perm-detail">{auth.detail}</p>
    </div>
  );
}
