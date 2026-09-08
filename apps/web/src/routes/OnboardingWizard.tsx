import { useCallback, useEffect, useState } from "react";
import type { Project } from "@pideck/shared";
import { apiGetGhAuth, apiGetPiAuth, errorMessage, type GhAuth, type PiAuth } from "../lib/api";
import { AutoAgentStep } from "./onboarding/AutoAgentStep";
import { GhPermissionStep } from "./onboarding/GhPermissionStep";
import { PiAuthStep } from "./onboarding/PiAuthStep";
import { RepoSourceStep } from "./onboarding/RepoSourceStep";
import { StepNav, type Step } from "./onboarding/StepNav";
import { INITIAL_FORM, autoAgentFormError, registerProject, sourceFormError, type WizardForm } from "./onboarding/wizard-form";

/**
 * Project onboarding wizard (issue #62): the former first-run onboarding
 * page, now reachable from the terminals sidebar's "+" button (rendered as a
 * modal) or the empty-state CTA in the main pane.
 *
 * Flow (PRD: repo connection):
 * 1. pi auth check (daemon-side probe via `GET /api/pi-auth`, issue #57):
 *    workers cannot run unauthenticated, so this step must pass (re-verify
 *    after the handoff: `pideck onboard`, or pi /login) before the
 *    wizard proceeds.
 * 2. gh permission check (daemon-side probe via `GET /api/gh-auth`).
 * 3. Choose the repo source: clone from git OR create a new GitHub repo —
 *    created repos are **private by default** with an explicit public toggle.
 * 4. Auto-create-agents question: should issues auto-create agents? Captures
 *    the GitHub username stored as the project's `autoAgentUsername`.
 *
 * Registration goes through the real `POST /api/projects` endpoint; on
 * success `onRegistered(project)` hands the new project back to the shell
 * (which closes the modal and opens the project's board).
 *
 * The step state machine and the cross-step form live here; each step panel
 * is a presentational component under `./onboarding/` (frame: StepPanel,
 * indicator: StepNav, shared form type + validation + registration:
 * wizard-form.ts).
 */
function OnboardingWizard({ onRegistered }: { onRegistered: (project: Project) => void }) {
  const [step, setStep] = useState<Step>("pi");
  const [form, setForm] = useState<WizardForm>(INITIAL_FORM);
  const [pi, setPi] = useState<PiAuth | null>(null);
  const [piError, setPiError] = useState<string | null>(null);
  const [checkingPi, setCheckingPi] = useState(true);
  const [auth, setAuth] = useState<GhAuth | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const patchForm = (patch: Partial<WizardForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
  };

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
      .then((result) => {
        setAuth(result);
        // Seed the auto-agent username from the gh login (user can override).
        setForm((current) => ({ ...current, username: current.username || result.login || "" }));
      })
      .catch((err: unknown) => setAuthError(errorMessage(err)))
      .finally(() => setChecking(false));
  }, []);

  useEffect(checkPi, [checkPi]);
  useEffect(checkPermissions, [checkPermissions]);

  const continueFromSource = (): void => {
    const message = sourceFormError(form);
    setFormError(message);
    if (message === null) setStep("autoagent");
  };

  const finish = (): void => {
    const message = autoAgentFormError(form);
    setFormError(message);
    if (message !== null) return;
    setSubmitting(true);
    registerProject(form)
      .then(onRegistered)
      .catch((err: unknown) => {
        setFormError(errorMessage(err));
        setSubmitting(false);
      });
  };

  return (
    <div className="wizard">
      <h1 className="page-title">Welcome to PiDeck</h1>
      <p className="empty">Connect a project to start orchestrating agents.</p>
      <StepNav step={step} />
      {step === "pi" && (
        <PiAuthStep checking={checkingPi} auth={pi} error={piError} onRecheck={checkPi} onContinue={() => setStep("permission")} />
      )}
      {step === "permission" && (
        <GhPermissionStep
          checking={checking}
          auth={auth}
          error={authError}
          onRecheck={checkPermissions}
          onContinue={() => setStep("source")}
        />
      )}
      {step === "source" && (
        <RepoSourceStep
          form={form}
          onChange={patchForm}
          onError={setFormError}
          error={formError}
          onContinue={continueFromSource}
          onBack={() => setStep("permission")}
        />
      )}
      {step === "autoagent" && (
        <AutoAgentStep
          form={form}
          onChange={patchForm}
          error={formError}
          submitting={submitting}
          onFinish={finish}
          onBack={() => setStep("source")}
        />
      )}
    </div>
  );
}

/**
 * The wizard rendered as a modal overlay over the terminals page (issue
 * #62) — launched from the sidebar's "+" button or an empty-state CTA.
 */
export function OnboardingModal({
  onClose,
  onRegistered,
}: {
  onClose: () => void;
  onRegistered: (project: Project) => void;
}) {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Project onboarding">
      <div className="modal-card">
        <button type="button" className="modal-close" aria-label="Close onboarding" onClick={onClose}>
          ×
        </button>
        <OnboardingWizard onRegistered={onRegistered} />
      </div>
    </div>
  );
}
