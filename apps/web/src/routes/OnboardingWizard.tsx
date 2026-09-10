import { useState } from "react";
import type { Project } from "@pideck/shared";
import { errorMessage } from "../lib/api";
import { Modal } from "../components/Modal";
import { RepoSourceStep } from "./onboarding/RepoSourceStep";
import { INITIAL_FORM, registerProject, sourceFormError, type WizardForm } from "./onboarding/wizard-form";

/**
 * Project onboarding wizard (issues #62, #183): reachable from the terminals
 * sidebar's "+" button (rendered as a modal) or the empty-state CTA in the
 * main pane.
 *
 * Flow (PRD: repo connection): a single step — choose the repo source
 * (clone from git OR create a new GitHub repo, created repos are **private
 * by default** with an explicit public toggle) and register. There is no
 * auto-agent question anymore (issue #416): worker spawning is
 * assignment-driven by default — the orchestrator assigns a GitHub user to
 * an issue, and the assignment spawns the worker.
 *
 * pi auth and gh auth are PiDeck-global, configured once — they live in the
 * global onboarding flow (`./onboarding/GlobalOnboarding.tsx`, issue #183),
 * never re-asked here.
 *
 * Registration goes through the real `POST /api/projects` endpoint; on
 * success `onRegistered(project)` hands the new project back to the shell
 * (which closes the modal and opens the project's board).
 *
 * The form state and registration live in `wizard-form.ts`; the step panel
 * is presentational under `./onboarding/`.
 */
function OnboardingWizard({ onRegistered }: { onRegistered: (project: Project) => void }) {
  const [form, setForm] = useState<WizardForm>(INITIAL_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const patchForm = (patch: Partial<WizardForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const register = (): void => {
    const message = sourceFormError(form);
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
      <h1 className="modal-title">Connect a project</h1>
      <p className="empty">Point PiDeck at a repository to start orchestrating agents.</p>
      <RepoSourceStep
        form={form}
        onChange={patchForm}
        onError={setFormError}
        error={formError}
        submitting={submitting}
        continueLabel="Finish — register project"
        onContinue={register}
      />
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
    <Modal label="Project onboarding" closeLabel="Close onboarding" onClose={onClose}>
      <OnboardingWizard onRegistered={onRegistered} />
    </Modal>
  );
}
