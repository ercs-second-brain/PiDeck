/**
 * The wizard's shared-onboarding-state entry logic (issue #165): reads the
 * daemon's one source of truth (`GET /api/onboarding` — the shell
 * installer's recorded results plus the live probes) once, and enters the
 * flow at the first genuinely incomplete step, so a step the shell
 * onboarding completed is never re-asked. A failed read (e.g. an older
 * daemon) degrades to "nothing recorded".
 */
import { useEffect, useState } from "react";
import { apiGetOnboardingState, type GhAuth, type OnboardingState, type PiAuth } from "../../lib/api";
import type { Step } from "./StepNav";

export function useOnboardingEntryStep(
  pi: PiAuth | null,
  auth: GhAuth | null,
  checkingPi: boolean,
  checking: boolean,
  setStep: (step: Step) => void,
): OnboardingState["recorded"] {
  const [recorded, setRecorded] = useState<OnboardingState["recorded"]>(null);
  const [decided, setDecided] = useState(false);

  useEffect(() => {
    apiGetOnboardingState()
      .then((state) => setRecorded(state.recorded))
      .catch(() => setRecorded(null));
  }, []);

  useEffect(() => {
    if (decided || checkingPi || checking) return;
    setDecided(true);
    if (pi?.ready !== true) return;
    setStep(auth?.authenticated === true ? "source" : "permission");
  }, [decided, checkingPi, checking, pi, auth, setStep]);

  return recorded;
}
