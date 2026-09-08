/**
 * Step 1 — pi auth gate (issue #57): workers cannot run unauthenticated, so
 * this step must pass before the wizard proceeds. Renders the daemon probe
 * state (shared with the settings banner via {@link PiAuthStatus}); the
 * Continue button stays disabled while no provider is ready.
 */
import type { PiAuth } from "../../lib/api";
import { PiAuthStatus } from "../../components/PiAuthBanner";
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
