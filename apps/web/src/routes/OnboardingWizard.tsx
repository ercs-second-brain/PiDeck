import { useState } from "react";
import type { Project } from "@pideck/shared";
import { errorMessage } from "../lib/api";
import { AutoAgentStep } from "./onboarding/AutoAgentStep";
import { RepoSourceStep } from "./onboarding/RepoSourceStep";
import { StepNav } from "./onboarding/StepNav";
import { INITIAL_FORM, autoAgentFormError, registerProject, sourceFormError, type ProjectStep, type WizardForm } from "./onboarding/wizard-form";

/** The project flow's steps (issue #183): project things only — repo source, then agents. */
const PROJECT_STEPS = [
  { key: "source", label: "1 · repository" },
  { key: "autoagent", label: "2 · agents" },
] as const;

/**
 * Project onboarding wizard (issues #62, #183): reachable from the terminals
 * sidebar's "+" button (rendered as a modal) or the empty-state CTA in the
 * main pane.
 *
 * Flow (PRD: repo connection) — project things only:
 * 1. Choose the repo source: clone from git OR create a new GitHub repo —
 *    created repos are **private by default** with an explicit public toggle.
 * 2. Auto-create-agents question: should issues auto-create agents? Captures
 *    the GitHub username stored as the project's `autoAgentUsername`.
 *
 * pi auth and gh auth are PiDeck-global, configured once — they live in the
 * global onboarding flow (`./onboarding/GlobalOnboarding.tsx`, issue #183),
 * never re-asked here.
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
  const [step, setStep] = useState<ProjectStep>("source");
  const [form, setForm] = useState<WizardForm>(INITIAL_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const patchForm = (patch: Partial<WizardForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
  };

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
      <h1 className="page-title">Connect a project</h1>
      <p className="empty">Point PiDeck at a repository to start orchestrating agents.</p>
      <StepNav steps={PROJECT_STEPS} step={step} />
      {step === "source" && (
        <RepoSourceStep form={form} onChange={patchForm} onError={setFormError} error={formError} onContinue={continueFromSource} />
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
