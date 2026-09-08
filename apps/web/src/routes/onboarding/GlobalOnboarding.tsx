import { useCallback, useEffect, useState } from "react";
import { apiGetGhAuth, apiGetPiAuth, errorMessage, type GhAuth, type PiAuth } from "../../lib/api";
import { GhPermissionStep } from "./GhPermissionStep";
import { PiAuthStep } from "./PiAuthStep";
import { RecordedNote } from "./RecordedNote";
import { StepNav } from "./StepNav";
import { useOnboardingEntryStep } from "./entry-step";

/** The global flow's steps (issue #183): pi auth is the hard gate, gh access second. */
const GLOBAL_STEPS = [
  { key: "pi", label: "1 · pi agent" },
  { key: "permission", label: "2 · gh access" },
] as const;

export type GlobalStep = (typeof GLOBAL_STEPS)[number]["key"];

/**
 * PiDeck-global onboarding (issue #183): pi auth and gh auth are daemon-wide
 * concerns, configured once — not per-project steps. This modal hosts the
 * former wizard's pi/gh steps and opens whenever pi has no ready provider:
 * on first run, and again later as the re-config path if auth breaks.
 *
 * Shared onboarding state (issue #165) stays the mechanism: the flow reads
 * `GET /api/onboarding` — the daemon-side source of truth combining the
 * shell installer's recorded results with the live probes — and enters at
 * the first genuinely incomplete step, never re-asking a completed one.
 *
 * Finishing hands control back to the shell (`onFinished`), which chains
 * into project onboarding when no project exists yet.
 */
function GlobalOnboarding({ onFinished }: { onFinished: () => void }) {
  const [step, setStep] = useState<GlobalStep>("pi");
  const [pi, setPi] = useState<PiAuth | null>(null);
  const [piError, setPiError] = useState<string | null>(null);
  const [checkingPi, setCheckingPi] = useState(true);
  const [auth, setAuth] = useState<GhAuth | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  // Issue #165: shared daemon-side onboarding state (recorded shell results
  // in the header; flow entered at the first incomplete step).
  const recorded = useOnboardingEntryStep(pi, auth, checkingPi, checking, setStep);

  const checkPi = useCallback(() => {
    setCheckingPi(true);
    setPiError(null);
    apiGetPiAuth()
      .then(setPi)
      .catch((err: unknown) => setPiError(errorMessage(err)))
      .finally(() => setCheckingPi(false));
  }, []);

  const checkPermissions = useCallback(() => {
    setChecking(true);
    setAuthError(null);
    apiGetGhAuth()
      .then(setAuth)
      .catch((err: unknown) => setAuthError(errorMessage(err)))
      .finally(() => setChecking(false));
  }, []);

  useEffect(checkPi, [checkPi]);
  useEffect(checkPermissions, [checkPermissions]);

  const piDone = pi?.ready === true;
  const ghDone = auth?.authenticated === true;
  const doneSteps: GlobalStep[] = [...(piDone ? (["pi"] as const) : []), ...(ghDone ? (["permission"] as const) : [])];

  return (
    <div className="wizard">
      <h1 className="page-title">Welcome to PiDeck</h1>
      <p className="empty">Set up the daemon's agent credentials once — every project reuses them.</p>
      {recorded !== null && <RecordedNote recorded={recorded} />}
      <StepNav steps={GLOBAL_STEPS} step={step} doneSteps={doneSteps} />
      {step === "pi" && (
        <PiAuthStep checking={checkingPi} auth={pi} error={piError} onRecheck={checkPi} onContinue={() => setStep("permission")} />
      )}
      {step === "permission" && (
        <GhPermissionStep checking={checking} auth={auth} error={authError} onRecheck={checkPermissions} onContinue={onFinished} />
      )}
    </div>
  );
}

/** The global onboarding rendered as a modal overlay over the terminals page. */
export function GlobalOnboardingModal({ onClose, onFinished }: { onClose: () => void; onFinished: () => void }) {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="PiDeck onboarding">
      <div className="modal-card">
        <button type="button" className="modal-close" aria-label="Close onboarding" onClick={onClose}>
          ×
        </button>
        <GlobalOnboarding onFinished={onFinished} />
      </div>
    </div>
  );
}
